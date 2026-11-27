/**
 * External services smoke test: real HTTP health probes with a timeout.
 *
 * Config: { timeout?, services: [{ name, url, method? = 'GET', expectedStatus? = 200 (number or array), headers? }] }
 */
const { notConfigured, summarize, request } = require('../../smoke-test-runner/scripts/smoke-util.js');

class SmokeTestExternalServices {
  constructor(config = {}) {
    this.config = { timeout: 10000, services: [], ...config };
  }

  async executeTests() {
    const services = this.config.services === undefined || this.config.services === null ? [] : this.config.services;
    if (!Array.isArray(services)) {
      return summarize('external service', [{ name: 'services', passed: false, reason: 'externalServices.services must be an array' }]);
    }
    if (!services.length) {
      return notConfigured('external services', 'set externalServices.services[] with name and url in smoke-tests.json');
    }
    const results = [];
    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      if (svc === null || typeof svc !== 'object' || Array.isArray(svc)) {
        results.push({ name: `service #${i + 1}`, passed: false, reason: `service #${i + 1} is not an object` });
        continue;
      }
      const hasUrl = typeof svc.url === 'string' && svc.url !== '';
      const name = typeof svc.name === 'string' && svc.name ? svc.name : (hasUrl ? svc.url : `service #${i + 1}`);
      if (!hasUrl) {
        results.push({ name, passed: false, reason: `service ${name} has no url` });
        continue;
      }
      const expected = [].concat(svc.expectedStatus === undefined ? 200 : svc.expectedStatus);
      const res = await request(svc.url, { method: svc.method || 'GET', headers: svc.headers, timeout: svc.timeout || this.config.timeout });
      if (res.status === null) results.push({ name, passed: false, reason: `request failed: ${res.error}` });
      else if (!expected.includes(res.status)) results.push({ name, passed: false, reason: `HTTP ${res.status} (expected ${expected.join('/')})` });
      else results.push({ name, passed: true, reason: `HTTP ${res.status} (${res.ms}ms)` });
    }
    return summarize('external service', results);
  }
}

module.exports = { SmokeTestExternalServices };

if (require.main === module) {
  const { loadSmokeConfig } = require('../../smoke-test-runner/scripts/smoke-util.js');
  const cfg = (loadSmokeConfig(process.argv[2]) || {}).externalServices || {};
  new SmokeTestExternalServices(cfg).executeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
