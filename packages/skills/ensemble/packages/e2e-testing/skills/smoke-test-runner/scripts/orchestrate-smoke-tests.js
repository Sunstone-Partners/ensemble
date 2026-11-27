/**
 * Smoke Test Runner - runs every smoke category in order against a project-supplied
 * smoke-tests.json|yaml. A category that is not configured is reported NOT CONFIGURED
 * and can never count as a pass; the overall verdict is only 'passed' when every
 * REQUIRED category actually executed and passed.
 *
 * CLI: node orchestrate-smoke-tests.js [--config smoke-tests.json] [--environment staging] [--no-stop]
 * Exit code 0 only when the verdict is passed.
 */
const { performance } = require('perf_hooks');
const { SmokeTestAPI } = require('./execute-health-checks.js');
const { SmokeTestDatabase } = require('./test-connectivity.js');
const { SmokeTestExternalServices } = require('./test-integrations.js');
const { SmokeTestAuth } = require('./test-auth-flows.js');
const { SmokeTestCriticalPaths } = require('./execute-journeys.js');
const { notConfigured, loadSmokeConfig } = require('./smoke-util.js');

/** Execution order; targets are advisory (exceeding one only warns). Total target <= 15 min. */
const SMOKE_TEST_CATEGORIES = [
  { id: 'api', name: 'API Health', skill: 'smoke-test-runner#api', configKey: 'api', target: 180000, order: 1 },
  { id: 'database', name: 'Database', skill: 'smoke-test-runner#database', configKey: 'database', target: 120000, order: 2 },
  { id: 'externalServices', name: 'External Services', skill: 'smoke-test-runner#external-services', configKey: 'externalServices', target: 180000, order: 3 },
  { id: 'auth', name: 'Auth', skill: 'smoke-test-runner#auth', configKey: 'auth', target: 120000, order: 4 },
  { id: 'criticalPaths', name: 'Critical Paths', skill: 'smoke-test-runner#critical-paths', configKey: 'criticalPaths', target: 300000, order: 5 }
];

class SmokeTestRunner {
  /**
   * @param {Object} config { environment, stopOnFirstFailure, categories, required, smokeConfig, configPath }
   *   smokeConfig: parsed smoke-tests.json (else loaded from configPath or ./smoke-tests.{json,yaml,yml}).
   *   required: category ids that must execute and pass (default: all categories run).
   */
  constructor(config = {}) {
    this.config = {
      environment: config.environment || 'staging',
      stopOnFirstFailure: config.stopOnFirstFailure !== false,
      categories: config.categories || SMOKE_TEST_CATEGORIES.map(c => c.id)
    };
    this.smokeConfig = config.smokeConfig || loadSmokeConfig(config.configPath) || {};
    this.required = config.required || this.smokeConfig.required || this.config.categories;
    this.results = {};
  }

  async executeAll() {
    const start = performance.now();
    const selected = SMOKE_TEST_CATEGORIES.filter(c => this.config.categories.includes(c.id));
    console.log(`[RUN] Smoke tests (${this.config.environment}): ${selected.map(c => c.id).join(', ')}`);
    let stopped = false;
    for (const category of selected) {
      if (stopped) {
        this.results[category.id] = { category: category.id, name: category.name, passed: false, status: 'not-run', duration: 0, reason: 'NOT RUN: earlier category failed' };
        continue;
      }
      const result = await this.executeCategory(category);
      this.results[category.id] = result;
      const label = { passed: 'OK', failed: 'FAIL', 'not-configured': 'NOT CONFIGURED' }[result.status] || result.status;
      console.log(`[${label}] ${category.name} (${result.duration}ms)${result.status === 'passed' ? '' : ': ' + result.reason}`);
      if (result.status === 'failed' && this.config.stopOnFirstFailure) stopped = true;
    }
    return this.buildVerdict(Math.round(performance.now() - start), selected);
  }

  async executeCategory(category) {
    const start = performance.now();
    let result;
    try {
      const cfg = this.smokeConfig[category.configKey];
      result = cfg ? await this.runCategory(category, cfg) : notConfigured(category.name, `no "${category.configKey}" section in smoke-tests.json`);
    } catch (error) {
      result = { passed: false, status: 'failed', reason: `Execution error: ${error.message}`, details: {}, results: [] };
    }
    const duration = Math.round(performance.now() - start);
    if (duration > category.target) console.warn(`[WARN] ${category.name} exceeded target (${duration}ms > ${category.target}ms)`);
    return {
      category: category.id,
      name: category.name,
      passed: result.status === 'passed',
      status: result.status || (result.passed ? 'passed' : 'failed'),
      duration,
      target: category.target,
      reason: result.reason,
      details: result.details,
      results: result.results
    };
  }

  async runCategory(category, rawCfg) {
    if (typeof rawCfg !== 'object' || Array.isArray(rawCfg)) {
      return { passed: false, status: 'failed', reason: `"${category.configKey}" section in smoke-tests.json must be an object`, details: {}, results: [] };
    }
    // top-level includeOutput applies to every category unless the category sets its own
    const cfg = { includeOutput: this.smokeConfig.includeOutput, ...rawCfg };
    const context = { environment: this.config.environment };
    switch (category.id) {
      case 'api': {
        const endpoints = cfg.endpoints || [];
        if (!cfg.baseUrl || !endpoints.length) return notConfigured('API Health', 'set api.baseUrl and api.endpoints[] in smoke-tests.json');
        const r = await new SmokeTestAPI(cfg).executeHealthChecks({ ...context, endpoints });
        return { ...r, status: r.passed ? 'passed' : 'failed' };
      }
      case 'database': return new SmokeTestDatabase(cfg).executeTests(context);
      case 'externalServices': return new SmokeTestExternalServices(cfg).executeTests(context);
      case 'auth': return new SmokeTestAuth(cfg).executeTests(context);
      case 'criticalPaths': return new SmokeTestCriticalPaths(cfg).executeTests(context);
      default: throw new Error(`Unknown category: ${category.id}`);
    }
  }

  /**
   * Verdict: 'passed' only if every required category executed and passed.
   * 'failed' if any executed category failed; 'incomplete' if no failure but a
   * required category was NOT CONFIGURED or not run. passed === (status === 'passed').
   */
  buildVerdict(totalDuration, selected) {
    const entries = selected.map(c => this.results[c.id]);
    const failed = entries.filter(r => r.status === 'failed');
    const missingRequired = entries.filter(r => this.required.includes(r.category) && (r.status === 'not-configured' || r.status === 'not-run'));
    const executedPassed = entries.filter(r => r.status === 'passed');
    const unrunRequired = this.required.filter(id => !selected.some(c => c.id === id));
    let status = 'passed';
    let reason = `All ${executedPassed.length} executed categories passed`;
    if (failed.length) {
      status = 'failed';
      reason = failed.map(f => `${f.name}: ${f.reason}`).join(' | ');
    } else if (missingRequired.length || unrunRequired.length) {
      status = 'incomplete';
      reason = [...missingRequired.map(m => `${m.name}: ${m.reason}`), ...unrunRequired.map(id => `${id}: required but not selected`)].join(' | ');
    } else if (!executedPassed.length) {
      status = 'incomplete';
      reason = 'No smoke test category executed';
    }
    return {
      status,
      passed: status === 'passed',
      reason,
      totalDuration,
      categoriesExecuted: entries.filter(r => r.status === 'passed' || r.status === 'failed').length,
      categoriesPassed: executedPassed.length,
      categoriesFailed: failed.length,
      categoriesNotConfigured: entries.filter(r => r.status === 'not-configured').length,
      results: this.results
    };
  }
}

/** Standard verdict envelope for a config that could not be loaded (no stack trace, no categories run). */
function configFailureVerdict(message) {
  return {
    status: 'failed',
    passed: false,
    reason: message,
    totalDuration: 0,
    categoriesExecuted: 0,
    categoriesPassed: 0,
    categoriesFailed: 0,
    categoriesNotConfigured: 0,
    results: {}
  };
}

module.exports = { SmokeTestRunner, SMOKE_TEST_CATEGORIES, configFailureVerdict };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const emit = r => {
    console.log(JSON.stringify(r, null, 2));
    console.log(r.passed ? '[OK] Smoke tests passed' : `[${r.status.toUpperCase()}] ${r.reason}`);
    process.exit(r.passed ? 0 : 1);
  };
  let runner;
  try {
    runner = new SmokeTestRunner({ configPath: opt('--config'), environment: opt('--environment'), stopOnFirstFailure: !args.includes('--no-stop') });
  } catch (e) {
    emit(configFailureVerdict(e.message));
  }
  runner.executeAll()
    .then(emit)
    .catch(e => { console.error(e.message); process.exit(2); });
}
