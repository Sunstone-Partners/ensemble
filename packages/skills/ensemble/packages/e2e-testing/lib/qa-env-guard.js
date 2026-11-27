'use strict';

/**
 * TRD-013: QA-environment resolution and unreachable-environment halt for
 * /ensemble:author-playwright-tests.
 *
 * Safety-critical (PRD REQ-013): pointing a test run at the wrong environment
 * could mutate real claim/case data. This module owns exactly two decisions:
 *
 *   1. resolveQaEnvUrl  - what URL is "the QA environment"?
 *   2. checkQaEnvReachable - is it actually up right now?
 *
 * AC-013-1's real, load-bearing guarantee is structural, not linguistic:
 * this module never hardcodes a URL and never has a default/fallback code
 * path, so it is physically incapable of resolving to a URL the caller did
 * not explicitly configure (see resolveQaEnvUrl below). The hostname-pattern
 * check in assertNotProductionLooking is a *secondary*, best-effort heuristic
 * that catches common "oops, pasted the prod URL" naming mistakes — it is
 * NOT a provable guarantee against every production-hostname naming scheme
 * teams might invent, and it should never be read as one. Don't oversell it.
 *
 * There is no real config source to read here — the actual
 * `TestConfiguration.*` C# class and its QA URL live in the consuming
 * application's project, not this repo (same precedent as test-runner-mode.js's
 * `e2e-auth-state.json` reference: name the concept, don't read/create
 * it). So this module never hardcodes a URL and never silently defaults to
 * one — the caller must explicitly configure the QA target (a direct URL or
 * the name of an env var that holds it). No config => hard error, never a
 * guessed URL (AC-013-1: always the designated QA environment, never prod).
 *
 * Convention: plain functions over plain data, injectable I/O via `opts`
 * (matches pr-state.js's `opts.exec`, implementation-grounding.js's
 * `opts.gitExec`) — no class, no retry/circuit-breaker machinery.
 */

const https = require('https');
const http = require('http');

/**
 * Per-segment "looks like production" test, applied after splitting a
 * hostname on `.`, `-`, and `_`. Deliberately a heuristic, not a provable
 * classifier — production naming conventions vary too much (prod1, prod2,
 * prodapi, prodweb, 2prod, prod_qa, ...) for one regex to be complete, and
 * being too aggressive risks flagging real words that merely start with
 * "prod" (producer, product, prodigy). This matches:
 *   - the bare token 'prod' or 'production' (e.g. app-prod, prod-01)
 *   - 'prod' + digits, or 'prod' + a known tech-role suffix (api/web/app/
 *     srv/svc/node/box/host) — e.g. prod1, prod2, prodapi, prodweb
 *   - digits + 'prod' at the end of the segment — e.g. 2prod
 * It intentionally does NOT match 'prod' followed by other letters (producer,
 * product) since those are real words, not "prod" + a tech suffix — and it
 * does NOT match a letter prefix + 'prod' (e.g. 'nonprod', which usually
 * means the opposite of production).
 */
const PROD_TOKEN_RE = /^(?:prod|production)$|^prod(?:\d+|api|web|app|srv|svc|server|service|node|box|host)$|^\d+prod$/i;

/**
 * Reject configured values that are obviously not a real QA URL. Kept
 * deliberately narrow: exact bare environment names, and a hostname whose
 * `.`/`-`/`_`-separated segments contain a token that looks like a
 * "prod"-flavored host name (see PROD_TOKEN_RE). This is a best-effort guard
 * against the most likely misconfiguration mistakes, not a general
 * prod-vs-qa classifier — there is no reliable in-repo signal for that, and
 * no regex can enumerate every naming convention a team might use.
 *
 * @param {string} url
 * @throws {Error} if the value looks like production or isn't a valid URL
 */
function assertNotProductionLooking(url) {
  const bareName = url.trim().toLowerCase();
  if (bareName === 'production' || bareName === 'prod') {
    throw new Error(
      `Configured QA environment value '${url}' looks like a bare environment name, not a URL — refusing to use it.`
    );
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Configured QA environment value '${url}' is not a valid URL.`);
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
    // Catches scheme-only garbage that the URL constructor parses without
    // throwing (e.g. a bare "host:port" like 'qa.example.com:443' with no
    // "https://" prefix parses as protocol="qa.example.com:" with an empty
    // hostname) -- these must not slip past the production-token check below
    // just because they have no hostname to inspect.
    throw new Error(`Configured QA environment value '${url}' is not a valid URL.`);
  }
  const hostname = parsed.hostname.toLowerCase();

  const segments = hostname.split(/[.\-_]/);
  if (segments.some((segment) => PROD_TOKEN_RE.test(segment))) {
    throw new Error(
      `Configured QA environment URL '${url}' has a host segment that looks like production ` +
        `('${hostname}') — refusing to run tests against it. Configure the actual QA environment URL instead.`
    );
  }
}

/**
 * Resolve the QA environment URL to run tests against.
 *
 * Never defaults or falls back to any hardcoded URL — the caller must supply
 * either a direct URL (`opts.url`) or the name of an env var that holds one
 * (`opts.envVar`, read from `opts.env` or `process.env`). If neither resolves
 * to a non-empty string, this throws rather than guessing (AC-013-1).
 *
 * @param {object} [opts]
 * @param {string} [opts.url] - the QA environment URL, passed explicitly
 * @param {string} [opts.envVar] - name of an env var holding the QA URL
 * @param {NodeJS.ProcessEnv} [opts.env] - env to read `envVar` from (default `process.env`)
 * @returns {string} the resolved, sanity-checked QA environment URL
 * @throws {Error} if no QA URL is configured, or it looks production-like
 */
function resolveQaEnvUrl(opts = {}) {
  const env = opts.env || process.env;

  let url = null;
  if (typeof opts.url === 'string' && opts.url.trim() !== '') {
    url = opts.url.trim();
  } else if (typeof opts.envVar === 'string' && opts.envVar.trim() !== '') {
    const fromEnv = env[opts.envVar];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      url = fromEnv.trim();
    }
  }

  if (!url) {
    throw new Error(
      'No QA environment URL configured. Pass opts.url explicitly, or opts.envVar naming an env var ' +
        'that holds it. Refusing to default to any hardcoded URL — that could accidentally target production.'
    );
  }

  assertNotProductionLooking(url);
  return url;
}

/**
 * Default reachability check: an HTTP(S) HEAD request. Injectable via
 * `opts.checkFn` so callers/tests never need a live network call.
 *
 * @param {string} url
 * @returns {Promise<boolean>} true if a response with status < 500 came back
 */
function defaultCheckFn(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https://') ? https : http;
    let req;
    try {
      req = client.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      });
    } catch {
      resolve(false);
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Check whether the resolved QA environment is reachable right now.
 *
 * On `reachable: false`, the caller (the author-playwright-tests orchestrator)
 * halts test execution for that AC — this function never suggests or returns
 * an alternate URL to fall back to (AC-013-5).
 *
 * @param {string} url - the QA URL from resolveQaEnvUrl()
 * @param {object} [opts]
 * @param {(url: string) => Promise<boolean>} [opts.checkFn] - injectable reachability check
 * @returns {Promise<{reachable: boolean, url: string, error: string|null}>}
 */
async function checkQaEnvReachable(url, opts = {}) {
  const checkFn = opts.checkFn || defaultCheckFn;

  let reachable = false;
  let error = null;
  try {
    reachable = Boolean(await checkFn(url));
  } catch (err) {
    reachable = false;
    error = err && err.message ? err.message : String(err);
  }

  return { reachable, url, error };
}

module.exports = { resolveQaEnvUrl, checkQaEnvReachable };

// ponytail self-check: `node packages/e2e-testing/lib/qa-env-guard.js`
// exercises resolution (explicit url, envVar, and the no-default failure)
// plus the prod-looking guard and both reachability outcomes, using a
// mocked checkFn — no live network call, no separate -TEST task exists for
// TRD-013 yet, so this is the interim coverage.
if (require.main === module) {
  const assert = require('assert');

  // explicit opts.url wins, gets trimmed
  assert.strictEqual(resolveQaEnvUrl({ url: '  https://qa.example.com  ' }), 'https://qa.example.com');

  // envVar path, read from an injected env object
  assert.strictEqual(
    resolveQaEnvUrl({ envVar: 'APP_QA_BASE_URL', env: { APP_QA_BASE_URL: 'https://app-qa.example.com' } }),
    'https://app-qa.example.com'
  );

  // nothing configured -> hard error, never a guessed/default URL
  assert.throws(() => resolveQaEnvUrl(), /No QA environment URL configured/);
  assert.throws(() => resolveQaEnvUrl({ envVar: 'UNSET_VAR', env: {} }), /No QA environment URL configured/);

  // bare environment names rejected outright
  assert.throws(() => resolveQaEnvUrl({ url: 'production' }), /looks like a bare environment name/);
  assert.throws(() => resolveQaEnvUrl({ url: 'Prod' }), /looks like a bare environment name/);

  // production-looking host segment rejected
  assert.throws(() => resolveQaEnvUrl({ url: 'https://app-prod.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://production.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://prod-01.example.com' }), /looks like production/);
  // no false positive on a host that merely contains "prod" as a substring, not a token
  assert.strictEqual(resolveQaEnvUrl({ url: 'https://producer-qa.example.com' }), 'https://producer-qa.example.com');

  // QA-flagged bypasses (prod as prefix/suffix of a segment, not just an
  // exact, fully-delimited segment) — must now be rejected
  assert.throws(() => resolveQaEnvUrl({ url: 'https://prodapi.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://prod1.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://app-prod2.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://prodweb.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://prodserver.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://prodservice.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://prod_qa.example.com' }), /looks like production/);
  assert.throws(() => resolveQaEnvUrl({ url: 'https://2prod.example.com' }), /looks like production/);

  // not a valid URL at all
  assert.throws(() => resolveQaEnvUrl({ url: 'not a url' }), /is not a valid URL/);

  // scheme-only garbage that URL parses without throwing but leaves hostname
  // empty (e.g. a missing "https://" prefix) must not slip past validation
  assert.throws(() => resolveQaEnvUrl({ url: 'qa.example.com:443' }), /is not a valid URL/);
  assert.throws(() => resolveQaEnvUrl({ url: 'localhost:3000' }), /is not a valid URL/);

  (async () => {
    // reachable, via mocked checkFn
    const okResult = await checkQaEnvReachable('https://qa.example.com', {
      checkFn: async () => true,
    });
    assert.deepStrictEqual(okResult, { reachable: true, url: 'https://qa.example.com', error: null });

    // unreachable -> caller halts, no alternate URL suggested anywhere in the result
    const downResult = await checkQaEnvReachable('https://qa.example.com', {
      checkFn: async () => false,
    });
    assert.strictEqual(downResult.reachable, false);
    assert.strictEqual(downResult.url, 'https://qa.example.com');
    assert.ok(!('fallback' in downResult) && !('alternateUrl' in downResult));

    // checkFn throwing is treated as unreachable, not a crash
    const errorResult = await checkQaEnvReachable('https://qa.example.com', {
      checkFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.strictEqual(errorResult.reachable, false);
    assert.strictEqual(errorResult.error, 'ECONNREFUSED');

    console.log('qa-env-guard.js self-check passed');
  })();
}
