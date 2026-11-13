'use strict';

/**
 * A run whose model call never happened (login missing, bad key, no credits, overload) is `incomplete` with a short
 * `provider error: ...` reason, never a skill failure: not counted toward reliability, exit 4, never cached or baselined.
 * Stub `claude` and `pi` binaries stand in for the runtimes; no model is ever called.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const claude = require('../lib/runners/claude');
const pi = require('../lib/runners/pi');
const envlib = require('../lib/env');

/* eslint-disable no-control-regex -- the tests assert that control characters are absent */
const RUN = path.join(__dirname, '../run.js');
const SCRATCH = path.join(os.homedir(), '.omp', 'trd-skills-eval', 'jest');
const SKILL = 'ensemble-create-prd';

let root;
beforeEach(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  root = fs.mkdtempSync(path.join(SCRATCH, 'pe-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const sub = (...p) => path.join(root, ...p);

const shq = (l) => `'${l.replace(/'/g, "'\\''")}'`;
const printLines = (lines) => `printf '%s\\n' ${lines.map(shq).join(' ')}`;

// ---- Claude stream lines --------------------------------------------------------------------------------------
const init = (skills) => JSON.stringify({ type: 'system', subtype: 'init', skills, plugins: [], model: 'claude-stub-1' });
const result = (o) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: 'done', ...o });
const AUTH = { is_error: true, num_turns: 1, total_cost_usd: 0, result: 'Failed to authenticate. API Error: 401 {"error":{"message":"Missing Anthropic API Key"}}' };
// ---- Pi stream lines ------------------------------------------------------------------------------------------
const systemEvent = (names) => JSON.stringify({ type: 'message_end', message: { role: 'system', content: '', sections: { preamble: 'p', ...(names.length && { skills: `<available_skills>\n${names.map((n) => `<skill><name>${n}</name></skill>`).join('')}\n</available_skills>` }) } } });
const assistant = (extra = {}) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'stub-model', provider: 'stub', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: { cost: { total: 0.01 } }, ...extra } });
const PI402 = { content: [], stopReason: 'error', errorMessage: '402: {"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits"}', usage: { cost: { total: 0 } } };
const turnEnd = '{"type":"turn_end","message":{"role":"assistant"}}';

/**
 * Install both stubs. `withLines` / `baseLines`: what each arm prints; `write`: the with-skill arm writes SUMMARY.md.
 * `withSeq`: when given, per-call line sets for the with-skill arm (call n uses withSeq[n-1]).
 */
function install({ claudeWith = [init([`ensemble-product:${SKILL}`]), result({})], claudeBase, piWith, piBase, write = true, claudeWithSeq = null, sleep = false }) {
  fs.mkdirSync(sub('bin'), { recursive: true });
  const seq = claudeWithSeq
    ? `n=$(cat '${sub('n')}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${sub('n')}'\ncase $n in ${claudeWithSeq.map((l, i) => `${i + 1}) ${l.write ? 'echo ok > SUMMARY.md; ' : ''}${printLines(l.lines)};;`).join(' ')} esac`
    : `${write ? 'echo ok > SUMMARY.md' : ':'}\n${printLines(claudeWith)}${sleep ? '\nsleep 30' : ''}`;
  fs.writeFileSync(sub('bin/claude'), `#!/bin/sh
case "$*" in *--plugin-dir*)
${seq}
;; *)
${printLines(claudeBase || [init(['verify']), result({})])}
;; esac
`, { mode: 0o755 });
  fs.writeFileSync(sub('bin/pi'), `#!/bin/sh
case "$*" in *--skill*) ${write ? 'echo ok > SUMMARY.md;' : ''} ${printLines(piWith || [systemEvent([SKILL]), assistant(), turnEnd])};;
*) ${printLines(piBase || [systemEvent([]), assistant(), turnEnd])};; esac
`, { mode: 0o755 });
}

function runEvals(args) {
  fs.mkdirSync(sub('skills', SKILL), { recursive: true });
  fs.cpSync(path.join(__dirname, '../skills', SKILL), sub('skills', SKILL), { recursive: true });
  fs.writeFileSync(sub('skills', SKILL, 'eval.json'), JSON.stringify({
    skill: SKILL, prompt: 'Write a summary of the repo', runtimes: ['claude', 'pi'], checks: [{ type: 'fileExists', path: 'SUMMARY.md' }],
  }));
  fs.mkdirSync(sub('scenarios'), { recursive: true });
  const env = {
    ...process.env, CI: 'false', GITHUB_ACTIONS: 'false', PATH: `${sub('bin')}:${process.env.PATH}`, EVALS_WORKDIR: sub('work'),
    EVALS_RESULTS_DIR: sub('results'), EVALS_SCENARIOS_DIR: sub('scenarios'), EVALS_SKILLS_DIR: sub('skills'),
    EVALS_PI_BIN: sub('bin/pi'), EVALS_CLAUDE_BIN: sub('bin/claude'),
  };
  const r = spawnSync('node', [RUN, '--skill', SKILL, '--concurrency', '1', '--model', 'stub-model', ...args], { encoding: 'utf8', env });
  const rf = fs.existsSync(sub('results')) ? fs.readdirSync(sub('results'))[0] : null;
  const report = rf ? JSON.parse(fs.readFileSync(sub('results', rf), 'utf8')) : null;
  const dirFiles = (d) => (fs.existsSync(sub(d)) ? fs.readdirSync(sub(d), { recursive: true }).filter((f) => !fs.statSync(sub(d, f)).isDirectory()) : []);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report, ev: report && report.results[0], cached: dirFiles('cache'), baselines: dirFiles('baselines') };
}
const withRuns = (r) => r.ev.runs.filter((x) => x.arm === 'with-skill');
const records = (r, arm) => r.report.records.filter((x) => x.arm === arm);

describe('Claude: a failed API call is incomplete, not a skill failure', () => {
  test('the 401 result line (Not logged in / Failed to authenticate) -> incomplete, exit 4, nothing cached or baselined, not counted', () => {
    install({ claudeWith: [init([`ensemble-product:${SKILL}`]), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }), result(AUTH)] });
    const r = runEvals(['--runtime', 'claude', '--repeats', '1']);
    expect(r.status).toBe(4);
    expect(r.ev.outcome).toBe('incomplete');
    expect(r.ev.withSkill).toMatchObject({ passes: 0, runs: 0, providerErrors: 1 });
    expect(r.stdout).toMatch(/\[with-skill 1\/1\] INCOMPLETE \(provider error: Failed to authenticate\. API Error: 401/);
    expect(r.stdout).not.toMatch(/\[with-skill 1\/1\] FAIL/);
    expect(r.stdout).toMatch(/1 run\(s\) hit a provider error/);
    expect(r.stdout).toMatch(/with-skill: 1 run\(s\) hit a provider error \(the model call failed\) and are not counted/); // per-skill report
    expect(r.stdout).not.toMatch(/cost cap/);
    expect(r.report.failed).toBe(0);
    expect(r.report.incomplete).toBe(1);
    const rec = records(r, 'with-skill')[0];
    expect(rec).toMatchObject({ outcome: 'incomplete', costUsd: 0 });
    expect(rec.incompleteReason).toMatch(/^provider error: Failed to authenticate/);
    expect(rec.costEstimated).toBeUndefined();
    expect(r.cached.filter((f) => /with/.test(f) || true).every((f) => !/incomplete/.test(f))).toBe(true);
    expect(r.baselines).toEqual([]);
    expect(r.stdout).not.toMatch(/^ {2}baseline summary: /m);
  });

  test('the incomplete run is not counted: 1 pass + 1 provider error under bar 1 of 2 is an incomplete eval, no baseline, the pass is not lost', () => {
    install({
      claudeWithSeq: [
        { write: true, lines: [init([`ensemble-product:${SKILL}`]), result({})] },
        { write: false, lines: [init([`ensemble-product:${SKILL}`]), result(AUTH)] },
      ],
    });
    const r = runEvals(['--runtime', 'claude', '--repeats', '2']);
    expect(r.status).toBe(4);
    expect(r.ev.outcome).toBe('incomplete');
    expect(r.ev.withSkill).toMatchObject({ passes: 1, runs: 1, providerErrors: 1 });
    expect(r.baselines).toEqual([]);
    expect(r.stdout).toMatch(/baseline summary not written/);
    expect(r.stdout).toMatch(/INCOMPLETE/);
  });

  test('a provider-failed baseline run is incomplete too (no startup event is demanded of a call that never happened)', () => {
    install({ claudeWith: [init([`ensemble-product:${SKILL}`]), result({})], claudeBase: [result(AUTH)] });
    const r = runEvals(['--runtime', 'claude', '--repeats', '1']);
    expect(r.status).toBe(4);
    expect(r.ev.baseline).toMatchObject({ runs: 0, providerErrors: 1, unverifiable: 0 });
    expect(records(r, 'baseline')[0].incompleteReason).toMatch(/^provider error:/);
    expect(r.baselines).toEqual([]);
  });

  test('a run that worked and failed its checks is still an ordinary fail (exit 1)', () => {
    install({ claudeWith: [init([`ensemble-product:${SKILL}`]), result({ num_turns: 4 })], write: false });
    const r = runEvals(['--runtime', 'claude', '--repeats', '1']);
    expect(r.status).toBe(1);
    expect(withRuns(r)[0].outcome).toBe('fail');
    expect(r.stdout).toMatch(/\[with-skill 1\/1\] FAIL/);
  });

  test('a max-turns stop stays the existing outcome even when its text mentions an API error', () => {
    install({ claudeWith: [init([`ensemble-product:${SKILL}`]), result({ subtype: 'error_max_turns', is_error: true, num_turns: 25, result: 'Reached max turns (25) after API Error 429 retries' })], write: false });
    const r = runEvals(['--runtime', 'claude', '--repeats', '1']);
    expect(r.status).toBe(1);
    expect(withRuns(r)[0].outcome).toBe('fail');
    expect(r.ev.withSkill.providerErrors).toBe(0);
  });

  test('a timeout stays timed_out even when an error result line was already printed', () => {
    install({ claudeWith: [init([`ensemble-product:${SKILL}`]), result(AUTH)], sleep: true, write: false });
    const r = runEvals(['--runtime', 'claude', '--repeats', '1', '--timeout', '2']);
    expect(withRuns(r)[0].outcome).toBe('timed_out');
    expect(r.ev.withSkill.providerErrors).toBe(0);
    expect(r.status).toBe(1);
  });

  test('a clean run whose answer merely mentions an error code is not a provider error', () => {
    install({ claudeWith: [init([`ensemble-product:${SKILL}`]), result({ result: 'Explained why the API returns 401 for a bad key' })] });
    const r = runEvals(['--runtime', 'claude', '--repeats', '1']);
    expect(withRuns(r)[0].outcome).toBe('pass');
  });

  test('the reason is short and free of control characters, and a key in the error text is redacted', () => {
    const long = `Failed to authenticate. API Error: 401 \u001b[31m\u0007${'x'.repeat(2000)} sk-ant-SECRETVALUE123`;
    install({ claudeWith: [init([`ensemble-product:${SKILL}`]), result({ ...AUTH, result: `key sk-ant-SECRETVALUE123 ${long}` })] });
    fs.mkdirSync(sub('skills'), { recursive: true });
    const env = { ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE123' };
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    let r;
    try { r = runEvals(['--runtime', 'claude', '--repeats', '1']); } finally { delete process.env.ANTHROPIC_API_KEY; }
    const reason = records(r, 'with-skill')[0].incompleteReason;
    expect(reason.length).toBeLessThanOrEqual('provider error: '.length + envlib.MAX_REASON);
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(JSON.stringify(r.report)).not.toContain('SECRETVALUE123');
    expect(r.stdout).not.toContain('SECRETVALUE123');
    expect(r.stdout).not.toMatch(/\u001b/);
  });
});

describe('Pi: an assistant message that ended in an error is incomplete', () => {
  test('stopReason error with the 402 text and no earlier success -> incomplete, exit 4, charged nothing (not the reservation)', () => {
    install({ piWith: [systemEvent([SKILL]), assistant(PI402), turnEnd] });
    const r = runEvals(['--runtime', 'pi', '--repeats', '1']);
    expect(r.status).toBe(4);
    expect(r.ev.outcome).toBe('incomplete');
    expect(r.stdout).toMatch(/\[with-skill 1\/1\] INCOMPLETE \(provider error: 402: \{"message":"Insufficient credits/);
    expect(r.stdout).not.toMatch(/\[with-skill 1\/1\] FAIL/);
    const rec = records(r, 'with-skill')[0];
    expect(rec).toMatchObject({ outcome: 'incomplete', costUsd: 0 });
    expect(rec.costEstimated).toBeUndefined();
    expect(rec.incompleteReason.length).toBeLessThanOrEqual('provider error: '.length + envlib.MAX_REASON);
    expect(r.baselines).toEqual([]);
    expect(r.cached.some((f) => /with-skill/.test(f))).toBe(false);
  });

  test('a run that worked (a successful message) and then failed its checks is still a fail', () => {
    install({ piWith: [systemEvent([SKILL]), assistant(), turnEnd], write: false });
    const r = runEvals(['--runtime', 'pi', '--repeats', '1']);
    expect(r.status).toBe(1);
    expect(withRuns(r)[0].outcome).toBe('fail');
  });
});

describe('stream rule units', () => {
  const feed = (lines) => { const s = pi.createStreamScanner(); lines.forEach((l) => s.feed(l)); return s.result().providerErrorText; };
  test('Pi: an error with no success is one; success then a final error is one; an error that a later success recovered from is not', () => {
    expect(feed([assistant(PI402)])).toMatch(/^402/);
    expect(feed([assistant(), assistant({ stopReason: 'error', errorMessage: 'overloaded' })])).toBe('overloaded');
    expect(feed([assistant(PI402), assistant()])).toBeNull();
    expect(feed([assistant()])).toBeNull();
    expect(feed([assistant({ stopReason: 'aborted' })])).toBeNull();
    expect(feed([assistant({ stopReason: 'error' })])).toBe('stopReason error');
  });

  test('Claude: error text needs a failed final result and is not a deliberate stop', () => {
    const t = (o) => claude.providerErrorOf(result(o));
    expect(t(AUTH)).toMatch(/^Failed to authenticate/);
    for (const text of ['Not logged in · Please run /login', 'API Error: 429 rate limited', 'API Error: 529 {"type":"overloaded_error"}', '403 Forbidden']) expect(t({ is_error: true, result: text })).not.toBeNull();
    expect(t({ is_error: false, result: 'API Error: 401 discussed' })).toBeNull();
    expect(t({ is_error: true, result: 'something else broke' })).toBeNull();
    expect(t({ is_error: true, subtype: 'error_max_budget_usd', result: 'API Error 500' })).toBeNull();
    expect(claude.providerErrorOf('')).toBeNull();
  });

  test('Claude runner: a timed-out run reports no provider error even with an error result line already in the stream', async () => {
    fs.mkdirSync(sub('bin'), { recursive: true });
    fs.writeFileSync(sub('bin/claude'), `#!/bin/sh\n${printLines([init(['x']), result(AUTH)])}\nsleep 30\n`, { mode: 0o755 });
    fs.mkdirSync(sub('ws'), { recursive: true });
    const r = await claude.run({ prompt: 'p', env: { PATH: process.env.PATH }, workspace: sub('ws'), timeoutMs: 1500 }, { bin: sub('bin/claude') });
    expect(r.timedOut).toBe(true);
    expect(r.providerError).toBeNull();
  });

  test('Pi runner: a timed-out run reports no provider error either', async () => {
    fs.mkdirSync(sub('bin'), { recursive: true });
    fs.writeFileSync(sub('bin/pi'), `#!/bin/sh\n${printLines([systemEvent([]), assistant(PI402)])}\nsleep 30\n`, { mode: 0o755 });
    fs.mkdirSync(sub('ws'), { recursive: true });
    const r = await pi.run({ prompt: 'p', env: { PATH: process.env.PATH }, workspace: sub('ws'), timeoutMs: 1500 }, { bin: sub('bin/pi') });
    expect(r.timedOut).toBe(true);
    expect(r.providerError).toBeNull();
  });

  test('shortReason strips control characters, redacts first and caps the length', () => {
    const s = envlib.shortReason(`a\u001b[0m\u0000b\n\tc sk-SECRET${'y'.repeat(500)}`, ['sk-SECRET']);
    expect(s).toBe(`a [0m b c [REDACTED]${'y'.repeat(500)}`.slice(0, envlib.MAX_REASON - 3) + '...');
    expect(envlib.shortReason('x'.repeat(1000)).length).toBe(envlib.MAX_REASON);
  });
});
