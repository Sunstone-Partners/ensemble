'use strict';

/**
 * `gate` is serialized per machine (kata mjyc). Two layers:
 *  - runGateFlow in-process: the lock brackets the run (and only the run), is released when the run throws, and a lock
 *    that cannot be had stops the gate before anything runs or posts.
 *  - the real CLI entry point, twice at once, against a real fixture repo: the CI step itself records when it started
 *    and finished, and the two intervals must not overlap. Fake: only `gh` and `npx` (no network, no Node download).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const cli = require('../lib/local-ci-cli');
const lock = require('../lib/local-ci-lock');
const { makeBaseRepo, cleanupBaseRepos, prInfoFor, fakePostStatus, fakeGhDir, PR } = require('./helpers/local-ci-base-repo');

const CLI_PATH = path.join(__dirname, '..', 'lib', 'local-ci-cli.js');
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const WORKFLOW = '.github/workflows/proof.yml';
const CONFIG_YAML = `workflows:
  - file: ${WORKFLOW}
    jobs:
      - id: proof
        matrix:
          node-version: [${NODE_MAJOR}]
steps:
  - name: unit-check
    cmd: node scripts/unit-check.js
status_context: ensemble/local-ci
`;
const WORKFLOW_YAML = `name: proof
on: [push]
jobs:
  proof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/unit-check.js
`;

const scratch = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-gate-lock-'));
  scratch.push(d);
  return d;
};
afterAll(() => {
  cleanupBaseRepos();
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const passingRun = (sha) => ({ ok: true, sha, failures: [], unmirrored: [], nodes: [{ node: 22, ok: true, steps: [] }] });

/** Deps for runGateFlow with a REAL lock in a private directory. */
function flowDeps(fx, lockDir, over = {}) {
  const post = fakePostStatus();
  const lockPath = path.join(lockDir, lock.LOCK_FILE);
  const deps = {
    ...cli.defaultDeps(),
    env: {},
    prInfo: prInfoFor(fx),
    postStatus: post,
    runGate: jest.fn((o) => passingRun(o.headSha)),
    acquireGateLock: () => lock.acquireFromEnv({ ENSEMBLE_LOCAL_CI_LOCK_DIR: lockDir, ENSEMBLE_LOCAL_CI_LOCK_TIMEOUT_MS: '0' }),
    ...over,
  };
  return { deps, post, lockPath };
}

const flowFixture = () => makeBaseRepo({ config: CONFIG_YAML, files: { [WORKFLOW]: WORKFLOW_YAML } });
const payload = (fx, extra = {}) => ({ repoRoot: fx.dir, headSha: fx.headSha, baseRef: fx.baseRef, repo: 'o/r', pr: PR, ...extra });

describe('runGateFlow and the gate lock', () => {
  it('holds the lock for the run and for nothing else, and reports queued_ms', async () => {
    const fx = flowFixture();
    const lockDir = tmpDir();
    const seen = {};
    const { deps, post, lockPath } = flowDeps(fx, lockDir);
    deps.runGate = jest.fn((o) => {
      seen.heldDuringRun = fs.existsSync(lockPath);
      return passingRun(o.headSha);
    });
    const origPost = deps.postStatus;
    deps.postStatus = (req) => {
      seen.heldDuringPost = fs.existsSync(lockPath);
      return origPost(req);
    };
    const r = await cli.runGateFlow(payload(fx), deps);
    expect(r).toMatchObject({ ok: true, posted: true, queued_ms: expect.any(Number) });
    expect(seen).toEqual({ heldDuringRun: true, heldDuringPost: false });
    expect(post.calls).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('a run that throws still releases the lock, so the next gate starts at once (AC3)', async () => {
    const fx = flowFixture();
    const lockDir = tmpDir();
    const { deps, lockPath } = flowDeps(fx, lockDir);
    deps.runGate = jest.fn(() => {
      throw new Error('runner exploded');
    });
    await expect(cli.runGateFlow(payload(fx), deps)).rejects.toThrow('runner exploded');
    expect(fs.existsSync(lockPath)).toBe(false);

    const next = flowDeps(fx, lockDir);
    const r = await cli.runGateFlow(payload(fx), next.deps);
    expect(r).toMatchObject({ ok: true, posted: true }); // the lock timeout is 0: a still-held lock would have refused
  });

  it('when the lock cannot be had the gate stops with a named error: nothing runs, nothing posts, the holder is untouched (AC3)', async () => {
    const fx = flowFixture();
    const lockDir = tmpDir();
    const lockPath = path.join(lockDir, lock.LOCK_FILE);
    const holder = { pid: process.pid, host: os.hostname(), token: 'busy-gate', acquiredAt: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(lockPath, JSON.stringify(holder)); // this very process is alive, so its lock is honoured
    const { deps, post } = flowDeps(fx, lockDir);
    const r = await cli.runGateFlow(payload(fx), deps);
    expect(r).toMatchObject({ ok: false, stage: 'lock', errorCode: 'lock-timeout', posted: false, mergeReady: false, lockHolder: { token: 'busy-gate' } });
    expect(r.error).toContain('lock-timeout');
    expect(deps.runGate).not.toHaveBeenCalled();
    expect(post.calls).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(holder);
  });

  it('the default wiring reads the policy from the process environment, and a malformed value refuses the gate', async () => {
    const fx = flowFixture();
    const { deps, post } = flowDeps(fx, tmpDir());
    deps.acquireGateLock = cli.defaultDeps().acquireGateLock;
    const saved = process.env.ENSEMBLE_LOCAL_CI_MAX_LOAD;
    process.env.ENSEMBLE_LOCAL_CI_MAX_LOAD = 'lots';
    try {
      const r = await cli.runGateFlow(payload(fx), deps);
      expect(r).toMatchObject({ ok: false, stage: 'lock', errorCode: 'bad-lock-policy' });
    } finally {
      if (saved === undefined) delete process.env.ENSEMBLE_LOCAL_CI_MAX_LOAD;
      else process.env.ENSEMBLE_LOCAL_CI_MAX_LOAD = saved;
    }
    expect(deps.runGate).not.toHaveBeenCalled();
    expect(post.calls).toHaveLength(0);
  });

  it('a gate with no lock available at all is refused, never run unserialized', async () => {
    const fx = flowFixture();
    const { deps } = flowDeps(fx, tmpDir());
    delete deps.acquireGateLock;
    const r = await cli.runGateFlow(payload(fx), deps);
    expect(r).toMatchObject({ ok: false, stage: 'lock' });
    expect(deps.runGate).not.toHaveBeenCalled();
  });

  it('an invalid request never queues: the lock is not even asked for', async () => {
    const fx = flowFixture();
    const { deps } = flowDeps(fx, tmpDir(), { prInfo: prInfoFor(fx, { baseRefName: 'main' }) }); // wrong base branch
    deps.acquireGateLock = jest.fn(deps.acquireGateLock);
    const r = await cli.runGateFlow(payload(fx), deps);
    expect(r).toMatchObject({ ok: false, stage: 'config' });
    expect(deps.acquireGateLock).not.toHaveBeenCalled();
  });

  it('dry runs queue too: they clone and run the same CI', async () => {
    const fx = flowFixture();
    const lockDir = tmpDir();
    const { deps, lockPath } = flowDeps(fx, lockDir);
    let held = false;
    deps.runGate = jest.fn((o) => {
      held = fs.existsSync(lockPath);
      return passingRun(o.headSha);
    });
    const r = await cli.runGateFlow(payload(fx, { dryRun: true }), deps);
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect(held).toBe(true);
  });
});

describe('the real CLI entry point, two gates at once (AC5)', () => {
  it('serializes them: the CI steps never overlap and the second reports queued_ms', async () => {
    const stepLog = path.join(tmpDir(), 'steps.jsonl');
    const lockDir = tmpDir();
    const HOLD_MS = 1500;
    const unitCheck = `'use strict';
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(stepLog)}, JSON.stringify({ event: 'start', at: Date.now() }) + '\\n');
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(stepLog)}, JSON.stringify({ event: 'end', at: Date.now() }) + '\\n');
}, ${HOLD_MS});
`;
    const fx = makeBaseRepo({
      config: CONFIG_YAML,
      files: { 'scripts/unit-check.js': unitCheck, [WORKFLOW]: WORKFLOW_YAML, '.gitignore': '.ensemble/local-ci-runs/\n' },
    });
    // Fake only the outside world: `gh pr view` answers for the PR, and `npx` "provides" the Node we are already running.
    const fakeDir = fakeGhDir({ baseRefName: 'trusted-base', headRefOid: fx.headSha, state: 'OPEN' });
    fs.writeFileSync(path.join(fakeDir, 'npx'), `#!/bin/sh\nprintf '%s\\n' '${process.execPath}'\n`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: fakeDir + path.delimiter + process.env.PATH,
      ENSEMBLE_LOCAL_CI_LOCK_DIR: lockDir,
      ENSEMBLE_LOCAL_CI_LOCK_TIMEOUT_MS: '60000',
    };
    const input = JSON.stringify({ repoRoot: fx.dir, headSha: fx.headSha, baseRef: fx.baseRef, repo: 'o/r', pr: PR, dryRun: true });
    const gate = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI_PATH, 'gate'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        child.on('close', (code) => resolve({ code, out, err }));
        child.stdin.end(input);
      });

    const [a, b] = await Promise.all([gate(), gate()]);
    const reports = [a, b].map((r) => {
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
      return JSON.parse(r.out);
    });
    for (const r of reports) expect(r).toMatchObject({ ok: true, dryRun: true, mergeReady: true });

    const events = fs.readFileSync(stepLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.event)).toEqual(['start', 'end', 'start', 'end']); // never start, start
    expect(events[2].at).toBeGreaterThanOrEqual(events[1].at);

    const queued = reports.map((r) => r.queued_ms).sort((x, y) => x - y);
    expect(queued[1]).toBeGreaterThanOrEqual(HOLD_MS * 0.6); // the later one waited for most of the first one's step
    expect(fs.existsSync(path.join(lockDir, lock.LOCK_FILE))).toBe(false);
  }, 120000);
});
