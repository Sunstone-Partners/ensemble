/**
 * Database smoke test: runs configured CLI commands (psql, mysql, redis-cli, sqlite3, ...)
 * and requires exit code 0 (and optional output match).
 *
 * Config: { timeout?, checks: [{ name, command, expectOutput? }] }  or  { command, expectOutput? }
 * Example: { "command": "psql \"$DATABASE_URL\" -tAc 'SELECT 1'", "expectOutput": "1" }
 */
const { notConfigured, summarize, runCommand, redact, describeFailure } = require('../../smoke-test-runner/scripts/smoke-util.js');

class SmokeTestDatabase {
  constructor(config = {}) {
    this.config = { timeout: 30000, ...config };
  }

  async executeTests() {
    const includeOutput = this.config.includeOutput === true;
    const raw = this.config.checks !== undefined && this.config.checks !== null
      ? this.config.checks
      : (this.config.command ? [{ name: 'connectivity', command: this.config.command, expectOutput: this.config.expectOutput }] : []);
    if (!Array.isArray(raw)) {
      return summarize('database', [{ name: 'checks', passed: false, reason: 'database.checks must be an array' }]);
    }
    if (!raw.length) {
      return notConfigured('database', 'set database.command (e.g. psql "$DATABASE_URL" -tAc "SELECT 1") in smoke-tests.json');
    }
    const results = [];
    for (let i = 0; i < raw.length; i++) {
      const check = raw[i];
      if (check === null || typeof check !== 'object' || Array.isArray(check)) {
        results.push({ name: `check #${i + 1}`, passed: false, reason: `check #${i + 1} is not an object` });
        continue;
      }
      const hasCommand = typeof check.command === 'string' && check.command.trim() !== '';
      const name = typeof check.name === 'string' && check.name ? check.name : (hasCommand ? redact(check.command) : `check #${i + 1}`);
      if (!hasCommand) {
        results.push({ name, passed: false, reason: `check ${name} has no command` });
        continue;
      }
      const out = await runCommand(check.command, { timeout: this.config.timeout });
      if (out.code !== 0) {
        results.push({ name, passed: false, reason: describeFailure(out, { includeOutput, timeout: this.config.timeout }) });
      } else if (check.expectOutput !== undefined && !out.stdout.includes(String(check.expectOutput))) {
        results.push({ name, passed: false, reason: `expected output not found: "${check.expectOutput}"` });
      } else {
        results.push({ name, passed: true, reason: `ok (${out.ms}ms)` });
      }
    }
    return summarize('database', results);
  }
}

module.exports = { SmokeTestDatabase };

if (require.main === module) {
  const { loadSmokeConfig } = require('../../smoke-test-runner/scripts/smoke-util.js');
  const cfg = (loadSmokeConfig(process.argv[2]) || {}).database || {};
  new SmokeTestDatabase(cfg).executeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
