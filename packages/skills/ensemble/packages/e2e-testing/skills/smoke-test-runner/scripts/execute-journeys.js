/**
 * Critical path smoke test: runs configured journeys; each step is a command or an HTTP call.
 *
 * Config: { baseUrl?, timeout?, journeys: [{ name, steps: [
 *   { command, expectExit? = 0, expectOutput? }
 *   | { path|url, method? = 'GET', body?, headers?, expectedStatus? = 200, expectBodyContains? } ] }] }
 */
const { notConfigured, summarize, request, runCommand, redact, describeFailure } = require('../../smoke-test-runner/scripts/smoke-util.js');

class SmokeTestCriticalPaths {
  constructor(config = {}) {
    this.config = { timeout: 30000, journeys: [], ...config };
  }

  async runStep(step) {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) return 'step is not an object';
    if (step.command !== undefined) {
      if (typeof step.command !== 'string' || !step.command.trim()) return 'step has an empty or non-string command';
      const includeOutput = this.config.includeOutput === true;
      const out = await runCommand(step.command, { timeout: this.config.timeout });
      const want = step.expectExit === undefined ? 0 : step.expectExit;
      if (out.code !== want) {
        const why = describeFailure(out, { includeOutput, timeout: this.config.timeout })
          .replace(/^exit (\d+)/, `exit $1 (expected ${want})`);
        return `command "${redact(step.command)}" ${why}`;
      }
      if (step.expectOutput !== undefined && !out.stdout.includes(String(step.expectOutput))) return `expected output not found: "${step.expectOutput}"`;
      return null;
    }
    const url = step.url || (this.config.baseUrl && step.path ? this.config.baseUrl + step.path : null);
    if (!url) return 'step needs command, url, or path (+ baseUrl)';
    const res = await request(url, { method: step.method || 'GET', headers: step.headers, body: step.body, timeout: this.config.timeout });
    const want = step.expectedStatus === undefined ? 200 : step.expectedStatus;
    if (res.status === null) return `request failed: ${res.error}`;
    if (res.status !== want) return `${step.method || 'GET'} ${url} -> HTTP ${res.status} (expected ${want})`;
    if (step.expectBodyContains !== undefined && !res.body.includes(String(step.expectBodyContains))) return `body missing "${step.expectBodyContains}"`;
    return null;
  }

  async executeTests() {
    const journeys = this.config.journeys === undefined || this.config.journeys === null ? [] : this.config.journeys;
    if (!Array.isArray(journeys)) {
      return summarize('critical path', [{ name: 'journeys', passed: false, reason: 'criticalPaths.journeys must be an array' }]);
    }
    if (!journeys.length) {
      return notConfigured('critical paths', 'set criticalPaths.journeys[] with steps in smoke-tests.json');
    }
    const results = [];
    for (let i = 0; i < journeys.length; i++) {
      const journey = journeys[i];
      if (journey === null || typeof journey !== 'object' || Array.isArray(journey)) {
        results.push({ name: `journey #${i + 1}`, passed: false, reason: `journey #${i + 1} is not an object` });
        continue;
      }
      const name = typeof journey.name === 'string' && journey.name ? journey.name : `journey #${i + 1}`;
      if (!Array.isArray(journey.steps) || !journey.steps.length) {
        results.push({ name, passed: false, reason: `journey ${name} has no steps` });
        continue;
      }
      const start = Date.now();
      let failure = null;
      for (let s = 0; s < journey.steps.length && !failure; s++) {
        const err = await this.runStep(journey.steps[s]);
        if (err) failure = `step ${s + 1}: ${err}`;
      }
      results.push({ name, passed: !failure, reason: failure || `ok (${Date.now() - start}ms)` });
    }
    return summarize('critical path', results);
  }
}

module.exports = { SmokeTestCriticalPaths };

if (require.main === module) {
  const { loadSmokeConfig } = require('../../smoke-test-runner/scripts/smoke-util.js');
  const cfg = (loadSmokeConfig(process.argv[2]) || {}).criticalPaths || {};
  new SmokeTestCriticalPaths(cfg).executeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
