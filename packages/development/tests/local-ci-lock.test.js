'use strict';

/**
 * Machine-wide gate lock (kata mjyc). Real filesystem in a temp dir; the clock, sleep, pid liveness, load average and
 * host name are injected where a test needs to control them. Every test states a guard that, if removed, makes it fail.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const lock = require('../lib/local-ci-lock');

const HOLDER = path.join(__dirname, 'helpers', 'local-ci-lock-holder.js');
const HOST = 'test-host';
const dirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-lock-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake clock: sleeping advances it, so timeouts are exercised without waiting. */
function fakeTime({ onSleep } = {}) {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
      if (onSleep) onSleep(sleeps.length);
    },
    sleeps,
  };
}

function setup(extraDeps = {}) {
  const dir = tmpDir();
  const lockPath = path.join(dir, 'gate.lock');
  const time = fakeTime(extraDeps.timeOptions);
  const deps = { now: time.now, sleep: time.sleep, host: HOST, pid: process.pid, isAlive: () => true, ...extraDeps.deps };
  return { dir, lockPath, time, deps };
}

const writeHolder = (lockPath, holder) => fs.writeFileSync(lockPath, JSON.stringify({ host: HOST, token: 'other-token', acquiredAt: '2026-01-01T00:00:00.000Z', ...holder }));
const readHolder = (lockPath) => JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f !== 'gate.lock');

describe('acquire / release', () => {
  it('creates a lock record naming this process and removes it on release; release is idempotent', async () => {
    const { dir, lockPath, deps } = setup();
    const l = await lock.acquire({ lockPath, timeoutMs: 0, deps });
    expect(l).toMatchObject({ acquired: true, queuedMs: 0, reclaimed: null });
    expect(readHolder(lockPath)).toMatchObject({ pid: process.pid, host: HOST });
    l.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(() => l.release()).not.toThrow();
    expect(leftovers(dir)).toEqual([]);
  });

  it('release never removes a lock that belongs to someone else', async () => {
    const { lockPath, deps } = setup();
    const l = await lock.acquire({ lockPath, timeoutMs: 0, deps });
    writeHolder(lockPath, { pid: 424242, token: 'someone-else' }); // our lock was (wrongly) replaced
    l.release();
    expect(readHolder(lockPath).token).toBe('someone-else');
  });

  it('creates the lock directory when it does not exist yet', async () => {
    const { dir, deps } = setup();
    const lockPath = path.join(dir, 'a', 'b', 'gate.lock');
    const l = await lock.acquire({ lockPath, timeoutMs: 0, deps });
    expect(l.acquired).toBe(true);
    l.release();
  });
});

describe('contention and stale detection', () => {
  it("a live holder's lock is honoured and left untouched (AC2)", async () => {
    const { lockPath, deps } = setup({ deps: { isAlive: () => true } });
    writeHolder(lockPath, { pid: 777 });
    const before = fs.readFileSync(lockPath, 'utf8');
    const r = await lock.acquire({ lockPath, timeoutMs: 0, deps });
    expect(r).toMatchObject({ acquired: false, code: 'lock-timeout', blockedBy: 'holder', holder: { pid: 777 } });
    expect(r.error).toContain('pid 777');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(before);
  });

  it('a lock whose pid is dead is reclaimed, and the reclaimed holder is reported (AC2, real dead pid)', async () => {
    const { dir, lockPath, time } = setup();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    writeHolder(lockPath, { pid: dead });
    const l = await lock.acquire({ lockPath, timeoutMs: 0, deps: { now: time.now, sleep: time.sleep, host: HOST } });
    expect(l.acquired).toBe(true);
    expect(l.reclaimed).toMatchObject({ pid: dead });
    expect(readHolder(lockPath).pid).toBe(process.pid);
    expect(leftovers(dir)).toEqual([]); // no tombstone left behind
  });

  it('an unreadable lock record is reclaimed rather than blocking forever', async () => {
    const { lockPath, deps } = setup();
    fs.writeFileSync(lockPath, '{not json');
    const l = await lock.acquire({ lockPath, timeoutMs: 0, deps });
    expect(l.acquired).toBe(true);
    expect(l.reclaimed).toEqual({ unreadable: true });
  });

  it('a lock written by another host cannot be judged stale from here and is honoured', async () => {
    const { lockPath, deps } = setup({ deps: { isAlive: () => false } });
    writeHolder(lockPath, { pid: 5, host: 'some-other-machine' });
    const r = await lock.acquire({ lockPath, timeoutMs: 0, deps });
    expect(r).toMatchObject({ acquired: false, code: 'lock-timeout' });
    expect(readHolder(lockPath).host).toBe('some-other-machine');
  });

  it('a waiter takes the lock once the holder releases, and reports how long it queued (AC1)', async () => {
    const { lockPath, deps } = setup();
    writeHolder(lockPath, { pid: 777 });
    // The holder lets go during the third poll.
    const time = fakeTime({ onSleep: (n) => n === 3 && fs.rmSync(lockPath) });
    const r = await lock.acquire({ lockPath, timeoutMs: 10_000, pollMs: 100, deps: { ...deps, now: time.now, sleep: time.sleep } });
    expect(r).toMatchObject({ acquired: true, queuedMs: 300 });
    expect(time.sleeps).toEqual([100, 100, 100]);
    expect(readHolder(lockPath).pid).toBe(process.pid);
  });

  it('times out with a named error, runs nothing and leaks no files (AC3)', async () => {
    const { dir, lockPath, deps, time } = setup();
    writeHolder(lockPath, { pid: 777 });
    const r = await lock.acquire({ lockPath, timeoutMs: 450, pollMs: 100, deps });
    expect(r).toMatchObject({ acquired: false, code: 'lock-timeout', queuedMs: 450, blockedBy: 'holder' });
    expect(time.sleeps).toEqual([100, 100, 100, 100, 50]); // the last sleep is clipped to the remaining budget
    expect(readHolder(lockPath).pid).toBe(777);
    expect(leftovers(dir)).toEqual([]);
  });

  it('puts back a live lock it moved aside by mistake instead of destroying it', async () => {
    // The lock looked stale when read, but a live process replaced it before our rename moved it aside.
    const { lockPath, deps } = setup({ deps: { isAlive: (pid) => pid !== 111 } });
    writeHolder(lockPath, { pid: 111, token: 'stale-token' });
    const realFs = require('fs');
    const racing = {
      ...realFs,
      renameSync: (from, to) => {
        writeHolder(lockPath, { pid: 222, token: 'fresh-live-token' });
        return realFs.renameSync(from, to);
      },
    };
    const r = await lock.acquire({ lockPath, timeoutMs: 0, deps: { ...deps, fs: racing } });
    expect(r.acquired).toBe(false);
    expect(readHolder(lockPath)).toMatchObject({ pid: 222, token: 'fresh-live-token' });
  });
});

describe('load policy', () => {
  it('refuse: a load above the ceiling is refused at once and takes no lock', async () => {
    const { dir, lockPath, deps } = setup({ deps: { loadavg: () => 30 } });
    const r = await lock.acquire({ lockPath, timeoutMs: 10_000, maxLoad: 12, loadPolicy: 'refuse', deps });
    expect(r).toMatchObject({ acquired: false, code: 'load-too-high', load: 30 });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('wait: proceeds once the load falls under the ceiling', async () => {
    const loads = [30, 25, 8];
    const { lockPath, deps, time } = setup({ deps: { loadavg: () => loads.shift() } });
    const r = await lock.acquire({ lockPath, timeoutMs: 10_000, pollMs: 100, maxLoad: 12, loadPolicy: 'wait', deps });
    expect(r).toMatchObject({ acquired: true, queuedMs: 200 });
    expect(time.sleeps).toEqual([100, 100]);
  });

  it('wait: a load that never falls ends in a timeout that names the load', async () => {
    const { lockPath, deps } = setup({ deps: { loadavg: () => 30 } });
    const r = await lock.acquire({ lockPath, timeoutMs: 300, pollMs: 100, maxLoad: 12, deps });
    expect(r).toMatchObject({ acquired: false, code: 'lock-timeout', blockedBy: 'load', load: 30 });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('no ceiling configured: the load average is never consulted', async () => {
    const { lockPath, deps } = setup({ deps: { loadavg: () => { throw new Error('must not be read'); } } });
    expect((await lock.acquire({ lockPath, timeoutMs: 0, deps })).acquired).toBe(true);
  });
});

describe('environment policy', () => {
  it('defaults to a persistent per-user directory outside /tmp, a 30 minute wait and no load check', () => {
    const p = lock.policyFromEnv({});
    expect(p).toMatchObject({ ok: true, timeoutMs: 30 * 60 * 1000, maxLoad: null, loadPolicy: 'wait' });
    expect(p.lockPath).toBe(path.join(os.homedir(), '.ensemble', 'locks', lock.LOCK_FILE));
  });

  it('reads the directory, timeout, ceiling and policy', () => {
    const p = lock.policyFromEnv({ ENSEMBLE_LOCAL_CI_LOCK_DIR: '/x/y', ENSEMBLE_LOCAL_CI_LOCK_TIMEOUT_MS: '0', ENSEMBLE_LOCAL_CI_MAX_LOAD: '12.5', ENSEMBLE_LOCAL_CI_LOAD_POLICY: 'refuse' });
    expect(p).toMatchObject({ ok: true, lockPath: path.join('/x/y', lock.LOCK_FILE), timeoutMs: 0, maxLoad: 12.5, loadPolicy: 'refuse' });
  });

  it.each([
    [{ ENSEMBLE_LOCAL_CI_LOCK_TIMEOUT_MS: 'soon' }, /TIMEOUT_MS/],
    [{ ENSEMBLE_LOCAL_CI_LOCK_TIMEOUT_MS: '-5' }, /TIMEOUT_MS/],
    [{ ENSEMBLE_LOCAL_CI_MAX_LOAD: 'high' }, /MAX_LOAD/],
    [{ ENSEMBLE_LOCAL_CI_MAX_LOAD: '0' }, /MAX_LOAD/],
    [{ ENSEMBLE_LOCAL_CI_LOAD_POLICY: 'ignore' }, /LOAD_POLICY/],
  ])('a malformed knob %j is an error, never silently ignored', async (env, re) => {
    expect(lock.policyFromEnv(env)).toMatchObject({ ok: false, error: expect.stringMatching(re) });
    const r = await lock.acquireFromEnv({ ENSEMBLE_LOCAL_CI_LOCK_DIR: tmpDir(), ...env });
    expect(r).toMatchObject({ acquired: false, code: 'bad-lock-policy' });
  });
});

describe('across real processes (AC1)', () => {
  it('two processes contending for one lock run one after the other; neither is lost', async () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'gate.lock');
    const logFile = path.join(dir, 'log.jsonl');
    const run = (label) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [HOLDER, lockPath, logFile, '500', label], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.on('close', (code) => resolve({ code, result: JSON.parse(out) }));
      });
    const [a, b] = await Promise.all([run('a'), run('b')]);
    expect([a.code, b.code]).toEqual([0, 0]);

    const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.event)).toEqual(['start', 'end', 'start', 'end']); // never start, start
    expect(events[0].label).toBe(events[1].label);
    expect(events[2].at).toBeGreaterThanOrEqual(events[1].at);

    const second = [a, b].find((r) => r.result.label === events[2].label).result;
    expect(second.queuedMs).toBeGreaterThanOrEqual(300); // it waited for most of the first holder's 500ms
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
