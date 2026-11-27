/**
 * Shared helpers for the smoke-test category scripts.
 * Every category returns { passed, status, reason, details, results } where
 * status is 'passed' | 'failed' | 'not-configured'. 'not-configured' is NEVER a pass.
 */
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_FILENAMES = ['smoke-tests.json', 'smoke-tests.yaml', 'smoke-tests.yml'];

function notConfigured(category, hint) {
  return {
    passed: false,
    status: 'not-configured',
    reason: `NOT CONFIGURED: ${category} - ${hint}`,
    details: {},
    results: []
  };
}

function summarize(label, results) {
  const failed = results.filter(r => !r.passed);
  const passed = failed.length === 0 && results.length > 0;
  return {
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? `All ${results.length} ${label} checks passed`
      : `${failed.length}/${results.length} ${label} checks failed: ${failed.map(f => `${f.name} (${f.reason})`).join('; ')}`,
    details: { total: results.length, passed: results.length - failed.length, failed: failed.length },
    results
  };
}

/** HTTP request; never throws. Resolves { status, body, ms, error }. */
function request(url, { method = 'GET', headers = {}, body, timeout = 10000 } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    let target;
    try { target = new URL(url); } catch { return resolve({ status: null, body: '', ms: 0, error: `invalid URL: ${url}` }); }
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (payload !== undefined && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method, headers: h, timeout }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, ms: Date.now() - start }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', e => resolve({ status: null, body: '', ms: Date.now() - start, error: e.message }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Run a shell command; never throws. Resolves { code, signal, timedOut, errorCode, stdout, stderr, ms }. */
function runCommand(command, { timeout = 30000, cwd, env } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    if (typeof command !== 'string' || !command.trim()) {
      return resolve({ code: null, signal: null, timedOut: false, errorCode: 'EINVAL', stdout: '', stderr: '', ms: 0 });
    }
    // Own process group (POSIX) so a timeout kills the shell AND its children: killing only the shell
    // leaves a grandchild holding the output pipes open and the promise pending until it exits.
    const group = process.platform !== 'win32';
    const child = spawn(command, { shell: true, cwd, env: { ...process.env, ...env }, detached: group });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (group) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, signal: null, timedOut: false, errorCode: e.code || 'ERROR', stdout, stderr, ms: Date.now() - start }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, signal: timedOut ? null : signal, timedOut, errorCode: null, stdout, stderr, ms: Date.now() - start });
    });
  });
}

const OUTPUT_LIMIT = 300;

/** Mask secrets in text (unbounded). Always mask BEFORE truncating so a secret cannot be cut mid-pattern. */
function maskSecrets(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1[REDACTED]@')
    .replace(/\b(authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s,;"']+/gi, (m, p, scheme) => `${p}${scheme ? `${scheme} ` : ''}[REDACTED]`)
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b([\w.-]*(?:key|token|password|passwd|pwd|secret)[\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/gi, '$1$2[REDACTED]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[REDACTED]')
    .trim();
}

/** Mask secrets in text, then bound it to 300 chars. */
function redact(text) {
  return maskSecrets(text).slice(0, OUTPUT_LIMIT);
}

/**
 * Failure reason for a failed runCommand result. NEVER includes raw subprocess output:
 * only exit code / signal / timeout / start failure. With includeOutput === true a REDACTED,
 * 300-char-bounded snippet of stderr and stdout (joined, then masked as ONE text so a secret split across
 * the two streams is still caught, then truncated) is appended.
 */
function describeFailure(out, { includeOutput = false, timeout } = {}) {
  let reason;
  if (out.errorCode) reason = out.errorCode === 'EINVAL' ? 'no command to run' : `could not start command (${out.errorCode})`;
  else if (out.timedOut) reason = `timeout after ${timeout}ms`;
  else if (out.signal) reason = `killed by signal ${out.signal}`;
  else reason = `exit ${out.code}${out.code === 127 ? ' (command not found)' : ''}`;
  if (includeOutput === true) {
    const snippet = maskSecrets([out.stderr, out.stdout].filter(Boolean).join('\n')).slice(0, OUTPUT_LIMIT);
    if (snippet) reason += `: ${snippet}`;
  }
  return reason;
}

/** Load smoke-tests.json|yaml from an explicit path or cwd. Returns null when absent. */
function loadSmokeConfig(explicitPath, cwd = process.cwd()) {
  const candidates = explicitPath ? [explicitPath] : CONFIG_FILENAMES.map(f => path.join(cwd, f));
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      if (explicitPath) throw new Error(`smoke config not found: ${file}`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    try {
      return file.endsWith('.json') ? JSON.parse(text) : require('js-yaml').load(text);
    } catch {
      // parser messages can quote config content (which may hold secrets): name the file only
      throw new Error(`smoke config could not be parsed: ${file}`);
    }
  }
  return null;
}

module.exports = { notConfigured, summarize, request, runCommand, redact, describeFailure, loadSmokeConfig, CONFIG_FILENAMES };

