/**
 * Auth smoke test: real login + protected-route checks against a configured service.
 *
 * Config: { baseUrl, login: { path, method?, body, tokenField? = 'token' },
 *           protected: { path, method?, tokenHeader? = 'Authorization', tokenPrefix? = 'Bearer ' } }
 */
const { notConfigured, summarize, request } = require('../../smoke-test-runner/scripts/smoke-util.js');

class SmokeTestAuth {
  constructor(config = {}) {
    this.config = { timeout: 10000, ...config };
  }

  async executeTests() {
    const { baseUrl, login, protected: prot } = this.config;
    if (!baseUrl || !login || !login.path || !prot || !prot.path) {
      return notConfigured('auth', 'set auth.baseUrl, auth.login.{path,body} and auth.protected.path in smoke-tests.json');
    }
    const timeout = this.config.timeout;
    const results = [];
    const record = (name, passed, reason) => results.push({ name, passed, reason });

    const res = await request(baseUrl + login.path, { method: login.method || 'POST', body: login.body, timeout });
    let token = null;
    if (res.status === null) record('login', false, `request failed: ${res.error}`);
    else if (res.status < 200 || res.status >= 300) record('login', false, `HTTP ${res.status}`);
    else {
      try { token = JSON.parse(res.body)[login.tokenField || 'token']; } catch { /* not JSON */ }
      record('login', Boolean(token), token ? `token received (${res.ms}ms)` : `no "${login.tokenField || 'token'}" in login response`);
    }

    const url = baseUrl + prot.path;
    const method = prot.method || 'GET';
    const anon = await request(url, { method, timeout });
    record('protected-rejects-anonymous', anon.status === 401 || anon.status === 403,
      anon.status === null ? `request failed: ${anon.error}` : `HTTP ${anon.status} (expected 401/403)`);

    if (token) {
      const headers = { [prot.tokenHeader || 'Authorization']: `${prot.tokenPrefix === undefined ? 'Bearer ' : prot.tokenPrefix}${token}` };
      const authed = await request(url, { method, headers, timeout });
      record('protected-accepts-token', authed.status >= 200 && authed.status < 300,
        authed.status === null ? `request failed: ${authed.error}` : `HTTP ${authed.status} (expected 2xx)`);
    } else {
      record('protected-accepts-token', false, 'skipped: no token from login');
    }
    return summarize('auth', results);
  }
}

module.exports = { SmokeTestAuth };

if (require.main === module) {
  const { loadSmokeConfig } = require('../../smoke-test-runner/scripts/smoke-util.js');
  const cfg = (loadSmokeConfig(process.argv[2]) || {}).auth || {};
  new SmokeTestAuth(cfg).executeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
