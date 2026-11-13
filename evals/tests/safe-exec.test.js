'use strict';

/**
 * PR 2 behavior: environment allowlist and redaction (TRD-005), workspace isolation (TRD-006),
 * cost cap, timeout and incomplete status (TRD-007). A stub `claude` stands in for the model; no model calls.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const envlib = require('../lib/env');
const { loadLimits, reservationFor, runSuite } = require('../lib/exec');
const { resolveWorkdir } = require('../lib/sandbox');

const RUN = path.join(__dirname, '../run.js');
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRATCH = path.join(os.homedir(), '.omp', 'trd-skills-eval', 'jest');

let root;
let extraPids;
beforeEach(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  root = fs.mkdtempSync(path.join(SCRATCH, 't-'));
  extraPids = [];
});
afterEach(() => {
  for (const pid of extraPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

const sub = (...p) => path.join(root, ...p);
const COST_LINE = (usd) => `echo '{"type":"result","num_turns":1,"total_cost_usd":${usd}}'`;
const HAS_SEED = [{ type: 'fileExists', path: 'seed.txt' }];

/** Write `n` agent scenarios s1..sn (fixture: seed.txt). `graders` may be a function of the index. */
function scenarios(n, graders = HAS_SEED) {
  const dir = sub('scenarios');
  for (let i = 1; i <= n; i++) {
    const d = path.join(dir, `s${i}`);
    fs.mkdirSync(path.join(d, 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(d, 'fixture', 'seed.txt'), 'seed\n');
    const g = typeof graders === 'function' ? graders(i) : graders;
    fs.writeFileSync(path.join(d, 'scenario.json'), JSON.stringify({ type: 'agent', prompt: 'do it', plugins: [], timeoutSec: 60, graders: g }));
  }
  return dir;
}

/** Run run.js with a stub claude whose body is `body`. Returns { status, stdout, stderr, report, workdir }. */
function run(args, { body, n = 1, graders, env = {} }) {
  const bin = sub('bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const workdir = sub('work');
  fs.mkdirSync(sub('skills'), { recursive: true });
  const base = {
    ...process.env, CI: 'false', GITHUB_ACTIONS: 'false', ANTHROPIC_API_KEY: undefined,
    PATH: `${bin}:${process.env.PATH}`, EVALS_WORKDIR: workdir, EVALS_RESULTS_DIR: sub('results'),
    EVALS_SCENARIOS_DIR: scenarios(n, graders), EVALS_SKILLS_DIR: sub('skills'), ...env,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  const r = spawnSync('node', [RUN, ...args], { encoding: 'utf8', env: base });
  let report = null;
  if (fs.existsSync(sub('results'))) {
    const f = fs.readdirSync(sub('results'))[0];
    if (f) report = JSON.parse(fs.readFileSync(sub('results', f), 'utf8'));
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report, workdir };
}

const outcomes = (rep) => rep.results.map((x) => x.outcome);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, ms = 4000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

describe('TRD-005 environment allowlist', () => {
  const SHELL_ADDED = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
  const body = (extra = '') => `env > "${root}/env.txt"\n${extra}\n${COST_LINE(0.01)}`;
  const names = () => fs.readFileSync(sub('env.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')[0]).filter((n) => !SHELL_ADDED.has(n));

  test('only allowlisted variables visible; non-allowlisted credential hidden', () => {
    const r = run(['--max-usd', '1'], { body: body(`echo "[$SECRET_X]" > "${root}/secret.txt"`), env: { SECRET_X: 'hunter2-secret', STRAY_VAR: 'stray', ANTHROPIC_API_KEY: 'sk-allowed' } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(sub('env.txt'))).toBe(true); // the stub ran
    const allowed = new Set([...envlib.BASE_NAMES, 'HOME', 'ANTHROPIC_API_KEY']);
    const seen = names();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((n) => !allowed.has(n))).toEqual([]);
    expect(seen).not.toContain('SECRET_X');
    expect(seen).not.toContain('STRAY_VAR');
    expect(fs.readFileSync(sub('secret.txt'), 'utf8').trim()).toBe('[]');
  });

  test('judge call also gets only the allowlisted environment', () => {
    const judgeBody = `case "$*" in
*stream-json*) ${COST_LINE(1)} ;;
*) env > "${root}/judge-env.txt"; echo '{"result":"{\\"score\\":1,\\"reason\\":\\"ok\\"}","total_cost_usd":0.5}' ;;
esac`;
    const r = run(['--max-usd', '10', '--model', 'sonnet', '--judge-model', 'opus'], {
      body: judgeBody, graders: [...HAS_SEED, { type: 'judge', rubric: 'good' }], env: { SECRET_X: 'hunter2-secret' },
    });
    expect(r.status).toBe(0);
    const txt = fs.readFileSync(sub('judge-env.txt'), 'utf8');
    expect(txt).toMatch(/^PATH=/m);
    expect(txt).not.toMatch(/SECRET_X|hunter2/);
  });

  test('HOME passes through locally', () => {
    const r = run(['--max-usd', '1'], { body: body(`echo "$HOME" > "${root}/home.txt"`), env: { HOME: '/home/maint' } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(sub('home.txt'), 'utf8').trim()).toBe('/home/maint');
    expect(r.report.env.homeMode).toBe('passthrough');
  });

  test.each([['CI'], ['GITHUB_ACTIONS']])('%s=true gives a fresh per-run HOME outside the repo, removed afterwards', (flag) => {
    const r = run(['--max-usd', '1'], {
      body: body(`echo "$HOME" > "${root}/home.txt"; [ -d "$HOME" ] && echo yes > "${root}/home-existed.txt"`),
      env: { HOME: '/home/maint', [flag]: 'true' },
    });
    expect(r.status).toBe(0);
    const home = fs.readFileSync(sub('home.txt'), 'utf8').trim();
    expect(home).not.toBe('/home/maint');
    expect(home.startsWith(`${r.workdir}${path.sep}`)).toBe(true);
    expect(path.relative(REPO_ROOT, home).startsWith('..')).toBe(true);
    expect(home.startsWith('/tmp')).toBe(false);
    expect(fs.existsSync(sub('home-existed.txt'))).toBe(true); // it existed during the run
    expect(fs.existsSync(home)).toBe(false); // removed afterwards
    expect(r.report.env.homeMode).toBe('ci-temp');
  });

  test('allowlisted credential is delivered (default and overridden names)', () => {
    let r = run(['--max-usd', '1'], { body: body(`echo "$ANTHROPIC_API_KEY|$OTHER_TOKEN" > "${root}/cred.txt"`), env: { ANTHROPIC_API_KEY: 'sk-allowed', OTHER_TOKEN: 'tok-other' } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(sub('cred.txt'), 'utf8').trim()).toBe('sk-allowed|'); // OTHER_TOKEN not on the allowlist
    run(['--max-usd', '1', '--allow-env', 'OTHER_TOKEN'], { body: body(`echo "$ANTHROPIC_API_KEY|$OTHER_TOKEN" > "${root}/cred.txt"`), env: { ANTHROPIC_API_KEY: 'sk-allowed', OTHER_TOKEN: 'tok-other' } });
    expect(fs.readFileSync(sub('cred.txt'), 'utf8').trim()).toBe('sk-allowed|tok-other');
  });

  test('credential names are editable in a file, replacing the default', () => {
    const file = sub('allow.json');
    fs.writeFileSync(file, JSON.stringify({ credentials: ['FILE_TOKEN'] }));
    run(['--max-usd', '1', '--env-allowlist', file], { body: body(`echo "$ANTHROPIC_API_KEY|$FILE_TOKEN" > "${root}/cred.txt"`), env: { ANTHROPIC_API_KEY: 'sk-allowed', FILE_TOKEN: 'tok-file' } });
    expect(fs.readFileSync(sub('cred.txt'), 'utf8').trim()).toBe('|tok-file');
  });

  test('allowlisted credential value never reaches stored results or logs', () => {
    const key = 'sk-ant-SUPER"SECRET-0123';
    const r = run(['--max-usd', '1'], {
      body: `echo "leak: $ANTHROPIC_API_KEY" >&2\necho '{"type":"result","num_turns":1,"total_cost_usd":0.01,"result":"my key is '"$ANTHROPIC_API_KEY"'"}' | sed 's/SUPER"SECRET/SUPER\\\\"SECRET/'\necho "raw $ANTHROPIC_API_KEY"`,
      env: { ANTHROPIC_API_KEY: key },
    });
    const files = fs.readdirSync(sub('results')).map((f) => fs.readFileSync(sub('results', f), 'utf8')).join('');
    expect(files).toContain('[REDACTED]'); // the stub did print the secret, so the check could fail
    for (const text of [files, r.stdout, r.stderr]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain('SUPER"SECRET');
      expect(text).not.toContain('SUPER\\"SECRET');
      expect(text).not.toContain('0123');
    }
  });

  test('stored result carries no environment values beyond allowlisted names', () => {
    const r = run(['--max-usd', '1'], { body: body(), env: { SECRET_X: 'hunter2-secret', STRAY_VAR: 'stray-value-77', ANTHROPIC_API_KEY: 'sk-allowed', HOME: '/home/maint' } });
    const text = JSON.stringify(r.report);
    for (const v of ['hunter2-secret', 'stray-value-77', 'sk-allowed', '/home/maint']) expect(text).not.toContain(v);
    expect(r.report.env.allowlisted.sort()).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR']);
    expect(Object.keys(r.report.env).sort()).toEqual(['allowlisted', 'homeMode']);
  });

  describe('env.js units', () => {
    test('buildEnv keeps only the allowlist and omits unset names', () => {
      const e = envlib.buildEnv({ parent: { PATH: '/bin', HOME: '/h', FOO: 'x', API: 'k', TERM: 'xterm' }, credentials: ['API', 'MISSING'] });
      expect(e).toEqual({ PATH: '/bin', TERM: 'xterm', API: 'k', HOME: '/h' });
      expect(envlib.buildEnv({ parent: { HOME: '/h' }, home: '/fresh' }).HOME).toBe('/fresh');
    });
    test('redaction covers raw and JSON-escaped values, nested and in keys, longest secret first', () => {
      const secrets = envlib.secretValues({ A: 'abc"def', B: 'abc"defGHI', C: '' }, ['A', 'B', 'C']);
      expect(secrets).toEqual(['abc"defGHI', 'abc"def']);
      const out = envlib.redactDeep({ x: ['k abc"defGHI'], 'abc"def': 1 }, secrets);
      expect(JSON.stringify(out)).toBe('{"x":["k [REDACTED]"],"[REDACTED]":1}');
      expect(envlib.redactText(JSON.stringify({ v: 'abc"def' }), secrets)).toBe('{"v":"[REDACTED]"}');
    });
    test('isCI and allowlist file validation', () => {
      expect(envlib.isCI({ CI: 'true' })).toBe(true);
      expect(envlib.isCI({ GITHUB_ACTIONS: 'true' })).toBe(true);
      expect(envlib.isCI({ CI: 'false' })).toBe(false);
      expect(envlib.loadCredentialNames({ file: sub('missing.json') })).toEqual(['ANTHROPIC_API_KEY']);
      expect(() => envlib.loadCredentialNames({ extra: ['bad name'] })).toThrow(/invalid environment variable name/);
      expect(envlib.loadCredentialNames()).toContain('ANTHROPIC_API_KEY'); // shipped evals/env-allowlist.json
    });
  });
});

/** Hash of the repository working tree state: index, tracked diff and untracked files. */
function treeHash(dir) {
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout;
  const h = crypto.createHash('sha1');
  h.update(g('ls-files', '-s'));
  h.update(g('diff', 'HEAD'));
  for (const f of g('ls-files', '-o', '--exclude-standard').split('\n').filter(Boolean).sort()) {
    h.update(f);
    try { h.update(fs.readFileSync(path.join(dir, f))); } catch { /* unreadable */ }
  }
  return h.digest('hex');
}

describe('TRD-006 workspace isolation', () => {
  test('treeHash detects a change (control)', () => {
    const d = sub('ctl');
    fs.mkdirSync(d);
    const git = (...a) => spawnSync('git', a, { cwd: d });
    git('init', '-q'); fs.writeFileSync(path.join(d, 'a'), '1'); git('add', '.');
    git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'i');
    const before = treeHash(d);
    expect(treeHash(d)).toBe(before);
    fs.writeFileSync(path.join(d, 'a'), '2');
    expect(treeHash(d)).not.toBe(before);
    fs.writeFileSync(path.join(d, 'a'), '1'); fs.writeFileSync(path.join(d, 'new'), 'x');
    expect(treeHash(d)).not.toBe(before);
  });

  test('each run starts in a fresh fixture copy outside the repository', () => {
    const log = sub('log.txt');
    const r = run(['--max-usd', '5', '--run-usd', '1', '--concurrency', '1'], {
      n: 2,
      body: `pwd >> "${log}"; ls -A | tr '\\n' ' ' >> "${log}"; echo >> "${log}"; cat seed.txt >> "${log}"\ntouch leftover.txt\n${COST_LINE(0.01)}`,
    });
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(6);
    const cwds = [lines[0], lines[3]];
    for (const c of cwds) {
      expect(fs.realpathSync(r.workdir) === c.slice(0, fs.realpathSync(r.workdir).length)).toBe(true);
      expect(path.relative(fs.realpathSync(REPO_ROOT), c).startsWith('..')).toBe(true);
      expect(c.startsWith('/tmp') || c.startsWith('/private/tmp')).toBe(false);
    }
    expect(cwds[0]).not.toBe(cwds[1]);
    for (const listing of [lines[1], lines[4]]) {
      expect(listing).toMatch(/seed\.txt/);
      expect(listing).toMatch(/\.git/);
      expect(listing).not.toMatch(/leftover/); // the second run never sees the first one's file
    }
    expect([lines[2], lines[5]]).toEqual(['seed', 'seed']);
  });

  test('repository unchanged, workspace removed; kept with --keep-workspace', () => {
    const before = treeHash(REPO_ROOT);
    const destroy = `rm -rf ./* ./.git; echo junk > scratch.txt; echo junk > ../outside.txt\n${COST_LINE(0.01)}`;
    let r = run(['--max-usd', '1'], { body: destroy });
    expect(treeHash(REPO_ROOT)).toBe(before);
    expect(fs.readdirSync(r.workdir)).toEqual([]);
    expect(r.stdout).not.toMatch(/workspace kept/);

    fs.rmSync(sub('results'), { recursive: true, force: true });
    r = run(['--max-usd', '1', '--keep-workspace'], { body: destroy });
    expect(treeHash(REPO_ROOT)).toBe(before);
    const kept = r.stdout.match(/workspace kept: (.+)/);
    expect(kept).not.toBeNull();
    expect(fs.existsSync(path.join(kept[1], 'scratch.txt'))).toBe(true);
    expect(kept[1].startsWith(r.workdir)).toBe(true);
  });

  test('EVALS_WORKDIR under /tmp or inside the repository is refused; default is ~/.omp/evals-work', () => {
    expect(() => resolveWorkdir({ EVALS_WORKDIR: '/tmp/x' })).toThrow(/\/tmp/);
    expect(() => resolveWorkdir({ EVALS_WORKDIR: '/private/tmp/x' })).toThrow(/\/tmp/);
    expect(() => resolveWorkdir({ EVALS_WORKDIR: path.join(REPO_ROOT, 'evals', 'work') })).toThrow(/outside the repository/);
    expect(resolveWorkdir({})).toBe(path.join(os.homedir(), '.omp', 'evals-work'));
  });
});

describe('TRD-007 cost cap, timeout, incomplete', () => {
  /** Stub that logs start/end lines (appends are ordered) and sleeps `sleep` seconds. */
  const slow = (usd, sleep = 1) => `echo start >> "${root}/events.txt"\nsleep ${sleep}\necho end >> "${root}/events.txt"\n${COST_LINE(usd)}`;
  const maxConcurrent = () => {
    let cur = 0; let max = 0;
    for (const l of fs.readFileSync(sub('events.txt'), 'utf8').split('\n').filter(Boolean)) { cur += l === 'start' ? 1 : -1; max = Math.max(max, cur); }
    return max;
  };
  const starts = () => fs.readFileSync(sub('events.txt'), 'utf8').split('\n').filter((l) => l === 'start').length;

  test('defaults: $50 cap, 900 s timeout, concurrency 4', () => {
    expect(loadLimits()).toMatchObject({ maxUsdPerSuite: 50, timeoutSec: 900, concurrency: 4 });
    const r = run([], { body: `echo "$@" > "${root}/argv.txt"\n${COST_LINE(0.01)}` });
    expect(r.report).toMatchObject({ maxUsd: 50, timeoutSec: 900, concurrency: 4 });
    expect(fs.readFileSync(sub('argv.txt'), 'utf8')).toMatch(/--max-budget-usd 5\b/);
  });

  test('cap stops new runs; finished runs keep results; incomplete is neither pass nor fail; exit 4', () => {
    const r = run(['--max-usd', '5', '--run-usd', '2', '--concurrency', '1'], { n: 5, body: slow(2, 0) });
    expect(starts()).toBe(2); // nothing started past the cap
    expect(outcomes(r.report)).toEqual(['pass', 'pass', 'incomplete', 'incomplete', 'incomplete']);
    expect(r.report).toMatchObject({ passed: 2, failed: 0, incomplete: 3, total: 5, totalCostUsd: 4 });
    expect(r.report.results[0]).toMatchObject({ pass: true, costUsd: 2 });
    expect(r.report.results[2].pass).toBeNull();
    expect(r.status).toBe(4);
  });

  test('reservation under concurrency: spend plus in-flight reservations never exceed the cap', () => {
    const r = run(['--max-usd', '5', '--run-usd', '2', '--concurrency', '4'], { n: 6, body: slow(2, 1) });
    expect(maxConcurrent()).toBe(2); // 3 x $2 reserved would be $6 > $5, although 4 slots are free
    expect(starts()).toBe(2);
    expect(r.report.peakCommittedUsd).toBeLessThanOrEqual(5);
    expect(r.report.peakCommittedUsd).toBe(4);
    expect(outcomes(r.report).filter((o) => o === 'incomplete')).toHaveLength(4);
    expect(r.report.totalCostUsd).toBe(4);
    expect(r.status).toBe(4);
  });

  test('failure outranks incomplete', () => {
    const r = run(['--max-usd', '2.5', '--run-usd', '2', '--concurrency', '1'], {
      n: 2, body: slow(2, 0), graders: (i) => (i === 1 ? [{ type: 'fileExists', path: 'nope.txt' }] : HAS_SEED),
    });
    expect(outcomes(r.report)).toEqual(['fail', 'incomplete']);
    expect(r.status).toBe(1);
  });

  test('timeout is recorded timed_out, never pass, exit 1', () => {
    const t0 = Date.now();
    const r = run(['--max-usd', '5', '--timeout', '1'], { body: `sleep 30\n${COST_LINE(0.01)}` });
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(r.report.results[0]).toMatchObject({ outcome: 'timed_out', pass: false, timedOut: true });
    expect(r.report).toMatchObject({ passed: 0, failed: 1, incomplete: 0 });
    expect(r.status).toBe(1);
  });

  test('timeout kills the stub and its grandchild (checked by pid)', async () => {
    const t0 = Date.now();
    const r = run(['--max-usd', '5', '--timeout', '1'], { body: `echo $$ > "${root}/stub.pid"\nsleep 30 &\necho $! > "${root}/grandchild.pid"\nsleep 30` });
    const stub = Number(fs.readFileSync(sub('stub.pid'), 'utf8'));
    const grandchild = Number(fs.readFileSync(sub('grandchild.pid'), 'utf8'));
    extraPids.push(stub, grandchild);
    expect(Date.now() - t0).toBeLessThan(15000); // a surviving grandchild holds the pipes open until its own 30 s sleep ends
    expect(stub).toBeGreaterThan(1);
    expect(grandchild).toBeGreaterThan(1);
    expect(grandchild).not.toBe(stub);
    expect(r.report.results[0].outcome).toBe('timed_out');
    expect(await waitDead(stub)).toBe(true);
    expect(await waitDead(grandchild)).toBe(true);
  });

  test('judge cost counts in costUsd and the suite spend', () => {
    const judgeBody = `case "$*" in
*stream-json*) ${COST_LINE(1.0)} ;;
*) echo '{"result":"{\\"score\\":0.9,\\"reason\\":\\"ok\\"}","total_cost_usd":0.5}' ;;
esac`;
    const r = run(['--max-usd', '5', '--model', 'sonnet', '--judge-model', 'opus'], { body: judgeBody, graders: [...HAS_SEED, { type: 'judge', rubric: 'good' }] });
    expect(r.report.results[0]).toMatchObject({ outcome: 'pass', costUsd: 1.5, judgedScore: 0.9 });
    expect(r.report.totalCostUsd).toBe(1.5);
  });

  test('judge allowance is part of the per-run reservation', () => {
    const limits = { runReserveUsd: 2, judgeReserveUsd: 1, capUsd: 4 };
    expect(reservationFor({ model: true, judged: false }, limits)).toBe(2);
    expect(reservationFor({ model: true, judged: true }, limits)).toBe(3);
    expect(reservationFor({ model: false, judged: false }, limits)).toBe(0);
    expect(reservationFor({ model: true, judged: true }, { ...limits, capUsd: 2.5 })).toBe(2.5);

    // End to end: $5 cap, two runs. Unjudged reserve $2 each so both fly together (peak 4);
    // judged reserve $3 each so the second waits for the first (peak 1.5 spent + 3 reserved = 4.5, never 6).
    const judgeBody = `case "$*" in
*stream-json*) sleep 1; ${COST_LINE(1)} ;;
*) echo '{"result":"{\\"score\\":1,\\"reason\\":\\"ok\\"}","total_cost_usd":0.5}' ;;
esac`;
    const flags = ['--max-usd', '5', '--run-usd', '2', '--judge-usd', '1', '--model', 'sonnet', '--judge-model', 'opus'];
    let r = run(flags, { n: 2, body: judgeBody });
    expect(r.report.peakCommittedUsd).toBe(4);
    fs.rmSync(sub('results'), { recursive: true, force: true });
    r = run(flags, { n: 2, body: judgeBody, graders: [...HAS_SEED, { type: 'judge', rubric: 'good' }] });
    expect(r.report.peakCommittedUsd).toBe(4.5);
    expect(r.report.peakCommittedUsd).toBeLessThanOrEqual(5);
    expect(outcomes(r.report)).toEqual(['pass', 'pass']);
    expect(r.report.totalCostUsd).toBe(3);
  });

  describe('runSuite scheduler', () => {
    const items = [1, 2, 3, 4, 5].map((id) => ({ id }));
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    test('lower actual spend frees budget for later runs', async () => {
      const out = await runSuite(items, { concurrency: 1, capUsd: 5, reserve: () => 2, run: async () => ({ costUsd: 0.5 }) });
      expect(out.done).toHaveLength(5);
      expect(out.unstarted).toEqual([]);
    });
    test('never starts a run that does not fit, even with free slots', async () => {
      let live = 0; let peak = 0;
      const out = await runSuite(items, {
        concurrency: 4, capUsd: 5, reserve: () => 2,
        run: async () => { live++; peak = Math.max(peak, live); await delay(30); live--; return { costUsd: 2 }; },
      });
      expect(peak).toBe(2);
      expect(out.peakCommitted).toBe(4);
      expect(out.done).toHaveLength(2);
      expect(out.unstarted).toHaveLength(3);
    });
    test('a thrown run is settled as an error result and does not stall the suite', async () => {
      const out = await runSuite(items.slice(0, 2), { concurrency: 2, capUsd: 50, reserve: () => 1, run: async (i) => { if (i.id === 1) throw new Error('boom'); return { costUsd: 0 }; } });
      expect(out.done.map((d) => d.result.error || 'ok').sort()).toEqual(['boom', 'ok']);
    });
  });
});
