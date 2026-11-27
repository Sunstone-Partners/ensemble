---
name: smoke-test-runner
description: Run all smoke test categories (API, database, external services, auth, critical paths) against a project-supplied smoke-tests.json and return one verdict. Use for a full pre-release or canary smoke run; not for a single category.
---

# Smoke Test Runner

Runs the five category scripts in order against the project's `smoke-tests.json` (or `.yaml`) in the working directory. The runner only reports what it actually executed.

## Usage

```bash
node skills/smoke-test-runner/scripts/orchestrate-smoke-tests.js [--config smoke-tests.json] [--environment staging] [--no-stop]
```

Exit code 0 only when the verdict is `passed`. Copy `templates/smoke-tests.example.json` as a starting point. Each category reads its own section (`api`, `database`, `externalServices`, `auth`, `criticalPaths`); the keys are in the Categories section below.

## Verdict (JSON on stdout)

`{ status, passed, reason, totalDuration, categoriesExecuted, categoriesPassed, categoriesFailed, categoriesNotConfigured, results }`

- `passed`: every required category executed and passed.
- `failed`: an executed category failed.
- `incomplete`: nothing failed, but a required category was NOT CONFIGURED or not run. This is **not** a pass and blocks promotion.
- `required` (config key) lists the category ids that must execute; default is every selected category. A non-required unconfigured category is reported NOT CONFIGURED and ignored.
- Per-category `results[id].status` is `passed`, `failed`, `not-configured` or `not-run`.
- A config file that is missing (explicit `--config`) or unparseable yields a `failed` verdict with a reason naming the file; no stack trace.

## Failure reasons and secrets

Verdict reasons never contain raw subprocess output, so secrets that a failing command prints (connection strings, tokens) cannot reach reports pasted into PRs, beads or CI. A failed command is reported as exit code, signal, timeout, `command not found`, or `expected output not found`. To see output, set `"includeOutput": true` (top-level, or inside a category section): a snippet of stderr and stdout is appended after masking each stream URL credentials, `Authorization`/`Bearer` values, `key=`/`token=`/`password=`/`secret=` values and long token-like strings, bounded to 300 characters. Masking is best effort; leave it off for sensitive systems.

## Timing

Advisory targets per category: API 3 min, database 2, external services 3, auth 2, critical paths 5 (total 15 minutes or less). Exceeding a target logs a warning; it does not fail the run.

## Programmatic

```javascript
const { SmokeTestRunner } = require('./scripts/orchestrate-smoke-tests.js');
const result = await new SmokeTestRunner({ environment: 'staging', configPath: 'smoke-tests.json' }).executeAll();
if (!result.passed) throw new Error(result.reason);
```

## Categories

### Smoke Test API

Config (`api` section of `smoke-tests.json`), as in `templates/smoke-tests.example.json`:

```json
{
 "baseUrl": "https://staging.example.com",
 "retries": 1,
 "endpoints": [
  {
   "path": "/health",
   "method": "GET",
   "expectedStatus": 200,
   "sla": 500
  }
 ]
}
```

Run: `node scripts/execute-health-checks.js [config-path]` (exit 1 on failure). Unconfigured means `status: "not-configured"`, never a pass.

### Smoke Test Auth

Config (`auth` section of `smoke-tests.json`):

```json
{ "baseUrl": "https://staging.example.com",
  "login": { "path": "/api/login", "body": { "email": "...", "password": "..." }, "tokenField": "token" },
  "protected": { "path": "/api/me" } }
```

Checks: `login` (2xx + token field in JSON), `protected-rejects-anonymous` (401/403), `protected-accepts-token` (2xx with `Authorization: Bearer <token>`; override with `tokenHeader`/`tokenPrefix`).

Run: `node scripts/test-auth-flows.js [config-path]` (exit 1 on failure). Result: `{ passed, status, reason, details, results }`.

Missing `baseUrl`, `login` or `protected` yields `status: "not-configured"` (`NOT CONFIGURED`), never a pass. Use a dedicated smoke account and keep credentials in your secret store.

### Smoke Test Database

Config (`database` section of `smoke-tests.json`): one command, or several named checks. The command runs through the shell with your environment, so connection strings can come from env vars.

```json
{ "command": "psql \"$DATABASE_URL\" -tAc 'SELECT 1'", "expectOutput": "1" }
{ "checks": [{ "name": "pg", "command": "psql \"$DATABASE_URL\" -tAc 'SELECT 1'", "expectOutput": "1" },
             { "name": "redis", "command": "redis-cli -u \"$REDIS_URL\" ping", "expectOutput": "PONG" }] }
```

A check fails on non-zero exit, timeout (`timeout`, default 30000 ms), missing binary, or missing `expectOutput`.

Run: `node scripts/test-connectivity.js [config-path]` (exit 1 on failure). Result: `{ passed, status, reason, details, results }`.

No command configured yields `status: "not-configured"` (`NOT CONFIGURED`), never a pass. Use a read-only account.

### Smoke Test External Services

Config (`externalServices` section of `smoke-tests.json`):

```json
{ "timeout": 10000,
  "services": [{ "name": "payments", "url": "https://status.example.com/health", "method": "GET", "expectedStatus": 200 }] }
```

`expectedStatus` may be a number or an array; `headers` is optional. A service fails on connection error, timeout, or unexpected status.

Run: `node scripts/test-integrations.js [config-path]` (exit 1 on failure). Result: `{ passed, status, reason, details, results }`.

No services configured yields `status: "not-configured"` (`NOT CONFIGURED`), never a pass. Probe health/status endpoints, not endpoints with side effects.

### Smoke Test Critical Paths

Config (`criticalPaths` section of `smoke-tests.json`). A journey passes only if every step passes; it stops at the first failing step.

```json
{ "baseUrl": "https://staging.example.com",
  "journeys": [{ "name": "checkout", "steps": [
    { "path": "/api/cart", "expectedStatus": 200, "expectBodyContains": "items" },
    { "path": "/api/orders", "method": "POST", "body": { "sku": "test" }, "expectedStatus": 201 },
    { "command": "npm run smoke:checkout", "expectExit": 0 } ] }] }
```

Step keys: HTTP (`path` or `url`, `method`, `body`, `headers`, `expectedStatus`, `expectBodyContains`) or command (`command`, `expectExit`, `expectOutput`). `timeout` (default 30000 ms) applies per step.

Run: `node scripts/execute-journeys.js [config-path]` (exit 1 on failure). Result: `{ passed, status, reason, details, results }`.

No journeys configured yields `status: "not-configured"` (`NOT CONFIGURED`), never a pass. For heavier flows, point a command step at your Playwright smoke suite.
