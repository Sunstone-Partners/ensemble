'use strict';

/**
 * Precheck entry point (kata 4ev6): the real deps against a real filesystem, with `gh`/`git` and the gate process
 * faked at the process boundary. Covers the parts the orchestrator tests cannot: the create-once start marker, the
 * detached start, finding OUR comment, and the protection read's classification of failures.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { makeDeps, validatePayload, main, STATE_SUBDIR } = require('../lib/review-precheck-cli');
const { runPrecheck, COMMENT_MARKER } = require('../lib/pr-review-precheck');

const HEAD = 'a'.repeat(40);
const BASE_SHA = 'e'.repeat(40);
// The repository's own committed gate config: a real, valid one (a hand-made stub would not pass validateConfig).
const CONFIG_YAML = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.ensemble', 'local-ci.yaml'), 'utf8');
const CONTEXT = /^status_context:\s*(\S+)/m.exec(CONFIG_YAML)[1];

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-cli-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout) => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
const fail = (stderr, stdout = '') => ({ status: 1, stdout, stderr });

/** A fake process boundary: `gh` answers by endpoint, `git` by subcommand. */
function fakeRun(table = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(' ')}`;
    for (const [needle, answer] of Object.entries(table)) {
      if (key.includes(needle)) return typeof answer === 'function' ? answer(args) : answer;
    }
    return fail(`unexpected ${key}`);
  };
  return { run, calls };
}

function fakeSpawn() {
  const spawned = [];
  const spawnProcess = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 5000 + spawned.length;
    child.unref = () => {};
    spawned.push({ cmd, args, opts });
    return child;
  };
  return { spawnProcess, spawned };
}

const deps = (over = {}) => makeDeps({ repo: 'o/r', pr: 9, repoRoot: root, ...over });

describe('validatePayload', () => {
  it('accepts the documented shape', () => {
    expect(validatePayload({ repo: 'o/r', pr: 9, repoRoot: '/x', dryRun: true })).toBeTruthy();
  });
  it('rejects unknown keys, a malformed repo, a bad PR number and a non-boolean dryRun', () => {
    for (const bad of [
      { repo: 'o/r', pr: 9, repoRoot: '/x', baseRef: 'origin/evil' },
      { repo: 'o/r; rm -rf', pr: 9, repoRoot: '/x' },
      { repo: '-o/r', pr: 9, repoRoot: '/x' },
      { repo: 'o/r', pr: '9', repoRoot: '/x' },
      { repo: 'o/r', pr: 0, repoRoot: '/x' },
      { repo: 'o/r', pr: 9, repoRoot: '' },
      { repo: 'o/r', pr: 9, repoRoot: '/x', dryRun: 'yes' },
    ]) {
      expect(() => validatePayload(bad)).toThrow();
    }
  });
});

describe('claimGateStart: a create-once marker', () => {
  it('exactly one of many concurrent claimers for a head wins', async () => {
    const d = deps();
    const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => d.claimGateStart({ headSha: HEAD, dryRun: false }))));
    expect(results.filter((r) => r.claimed === true)).toHaveLength(1);
    expect(results.filter((r) => r.claimed === false && r.existing)).toHaveLength(7);
  });

  it('a different head, and the dry-run namespace, are independent claims', () => {
    const d = deps();
    expect(d.claimGateStart({ headSha: HEAD, dryRun: false }).claimed).toBe(true);
    expect(d.claimGateStart({ headSha: 'b'.repeat(40), dryRun: false }).claimed).toBe(true);
    expect(d.claimGateStart({ headSha: HEAD, dryRun: true }).claimed).toBe(true);
    expect(d.claimGateStart({ headSha: HEAD, dryRun: false }).claimed).toBe(false);
  });

  it('release makes the head claimable again', () => {
    const d = deps();
    d.claimGateStart({ headSha: HEAD, dryRun: false });
    d.releaseGateStart({ headSha: HEAD, dryRun: false });
    expect(d.claimGateStart({ headSha: HEAD, dryRun: false }).claimed).toBe(true);
  });

  it('reports whether the earlier gate process is still alive', async () => {
    const d = deps();
    d.claimGateStart({ headSha: HEAD, dryRun: false });
    const marker = path.join(root, STATE_SUBDIR, `precheck-pr-9-${HEAD}.gate.json`);
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: 't0' }));
    expect(d.claimGateStart({ headSha: HEAD, dryRun: false }).existing).toMatchObject({ pid: process.pid, alive: true, startedAt: 't0' });
    fs.writeFileSync(marker, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 't0' }));
    expect(d.claimGateStart({ headSha: HEAD, dryRun: false }).existing.alive).toBe(false);
  });
});

describe('startGate', () => {
  const gitOk = { 'fetch --quiet origin dev': ok(''), [`fetch --quiet origin ${HEAD}`]: ok('') };

  it('runs `local-ci-cli gate` detached with its payload from a file and its output to a log, then records the pid', async () => {
    const { run } = fakeRun(gitOk);
    const { spawnProcess, spawned } = fakeSpawn();
    const d = deps({ run, spawnProcess, now: () => new Date('2026-11-06T00:00:00Z') });
    d.claimGateStart({ headSha: HEAD, dryRun: false });
    const r = await d.startGate({ headSha: HEAD, baseRefName: 'dev', dryRun: false });
    expect(r).toMatchObject({ ok: true, pid: 5000, startedAt: '2026-11-06T00:00:00.000Z' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args[1]).toBe('gate');
    expect(spawned[0].opts.detached).toBe(true);
    const input = JSON.parse(fs.readFileSync(path.join(root, STATE_SUBDIR, `precheck-pr-9-${HEAD}.gate-input.json`), 'utf8'));
    expect(input).toEqual({ repoRoot: root, headSha: HEAD, baseRef: 'origin/dev', repo: 'o/r', pr: 9 });
    const marker = JSON.parse(fs.readFileSync(path.join(root, STATE_SUBDIR, `precheck-pr-9-${HEAD}.gate.json`), 'utf8'));
    expect(marker.pid).toBe(5000);
  });

  it('a dry run starts the gate in the gate\'s own dry-run mode so it publishes no status', async () => {
    const { run } = fakeRun(gitOk);
    const { spawnProcess } = fakeSpawn();
    const d = deps({ run, spawnProcess });
    d.claimGateStart({ headSha: HEAD, dryRun: true });
    await d.startGate({ headSha: HEAD, baseRefName: 'dev', dryRun: true });
    const input = JSON.parse(fs.readFileSync(path.join(root, STATE_SUBDIR, `precheck-pr-9-${HEAD}.dry.gate-input.json`), 'utf8'));
    expect(input.dryRun).toBe(true);
  });

  it('does not start the gate when the base cannot be fetched fresh', async () => {
    const { run } = fakeRun({ 'fetch --quiet origin dev': fail('network down') });
    const { spawnProcess, spawned } = fakeSpawn();
    const d = deps({ run, spawnProcess });
    const r = await d.startGate({ headSha: HEAD, baseRefName: 'dev', dryRun: false });
    expect(r.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('fetches the PR head before the gate starts: the gate checks base/head history in this clone first', async () => {
    const { run, calls } = fakeRun(gitOk);
    const { spawnProcess, spawned } = fakeSpawn();
    const d = deps({ run, spawnProcess });
    await d.startGate({ headSha: HEAD, baseRefName: 'dev', dryRun: false });
    const fetchHead = calls.findIndex((c) => c.join(' ') === `git fetch --quiet origin ${HEAD}`);
    expect(fetchHead).toBeGreaterThan(-1);
    expect(spawned).toHaveLength(1);
  });

  it('falls back to the PR ref when the sha cannot be fetched, and does not start when neither can', async () => {
    const viaRef = fakeRun({ 'fetch --quiet origin dev': ok(''), [`fetch --quiet origin ${HEAD}`]: fail('no'), 'refs/pull/9/head': ok('') });
    const a = fakeSpawn();
    expect((await deps({ run: viaRef.run, spawnProcess: a.spawnProcess }).startGate({ headSha: HEAD, baseRefName: 'dev', dryRun: false })).ok).toBe(true);
    const neither = fakeRun({ 'fetch --quiet origin dev': ok(''), [`fetch --quiet origin ${HEAD}`]: fail('no'), 'refs/pull/9/head': fail('no') });
    const b = fakeSpawn();
    const r = await deps({ run: neither.run, spawnProcess: b.spawnProcess }).startGate({ headSha: HEAD, baseRefName: 'dev', dryRun: false });
    expect(r.ok).toBe(false);
    expect(b.spawned).toHaveLength(0);
  });

  it('reports a spawn that fails asynchronously instead of claiming the gate started', async () => {
    const { run } = fakeRun(gitOk);
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('error', new Error('ENOENT')));
      return child;
    };
    const r = await deps({ run, spawnProcess }).startGate({ headSha: HEAD, baseRefName: 'dev', dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOENT');
  });
});

describe('start-once through the entry flow (AC1)', () => {
  const table = (extra = {}) => ({
    'pr view': ok({ headRefOid: HEAD, baseRefName: 'dev', state: 'OPEN', body: '## Testing\nx\n## Risk\nx\n## How to revert\nx\n', author: { login: 'author' }, isCrossRepository: false }),
    'pulls/9/reviews': ok([[]]),
    'git/commits': ok({ tree: { sha: 'c'.repeat(40) } }),
    'branches/dev/protection': fail('gh: Branch not protected (HTTP 404)', JSON.stringify({ message: 'Branch not protected' })),
    '/statuses': ok([[]]),
    'fetch --quiet origin dev': ok(''),
    [`fetch --quiet origin ${HEAD}`]: ok(''),
    'rev-parse --verify --end-of-options refs/remotes/origin/dev^{commit}': ok(`${BASE_SHA}\n`),
    [`show ${BASE_SHA}:.ensemble/local-ci.yaml`]: ok(CONFIG_YAML),
    'cat-file -e': fail('missing'),
    'api user': ok({ login: 'me' }),
    'issues/9/comments': ok([[]]),
    '-X POST': ok({ id: 1, html_url: 'u' }),
    ...extra,
  });

  it('two precheck runs on one head start the gate once and the second says it was already started', async () => {
    const { run } = fakeRun(table());
    const { spawnProcess, spawned } = fakeSpawn();
    const first = await runPrecheck({}, deps({ run, spawnProcess }));
    const second = await runPrecheck({}, deps({ run, spawnProcess }));
    expect(first.gate.action).toBe('started');
    expect(second.gate.action).toBe('already-started');
    expect(spawned).toHaveLength(1);
  });

  it('does not start the gate when GitHub already shows the status on this head', async () => {
    const { run } = fakeRun(table({ '/statuses': ok([[{ context: CONTEXT, state: 'success' }]]) }));
    const { spawnProcess, spawned } = fakeSpawn();
    const r = await runPrecheck({}, deps({ run, spawnProcess }));
    expect(r.gate.action).toBe('status-present');
    expect(spawned).toHaveLength(0);
  });

  it('reads the status context from the base-ref config: a config naming another context changes the decision', async () => {
    const { run } = fakeRun(table({ '/statuses': ok([[{ context: CONTEXT, state: 'success' }]]), [`show ${BASE_SHA}:.ensemble/local-ci.yaml`]: ok(CONFIG_YAML.replace(CONTEXT, 'other/ci')) }));
    const { spawnProcess, spawned } = fakeSpawn();
    const r = await runPrecheck({}, deps({ run, spawnProcess }));
    expect(r.gate.action).toBe('started');
    expect(spawned).toHaveLength(1);
  });

  it('an absent policy file means strict defaults, so the approvals floor is one human', async () => {
    const { run } = fakeRun(table());
    const r = await runPrecheck({ dryRun: true }, deps({ run, spawnProcess: fakeSpawn().spawnProcess }));
    expect(r.approvals).toMatchObject({ required: 1, lowerBound: true });
  });

  it('asks GitHub whether the head is on a fork and starts nothing for one: no fetch, no claim, no gate (review round 1, finding 3)', async () => {
    const forkPr = ok({ headRefOid: HEAD, baseRefName: 'dev', state: 'OPEN', body: '## Testing\nx\n## Risk\nx\n## How to revert\nx\n', author: { login: 'author' }, isCrossRepository: true });
    const { run, calls } = fakeRun(table({ 'pr view': forkPr }));
    const { spawnProcess, spawned } = fakeSpawn();
    const r = await runPrecheck({}, deps({ run, spawnProcess }));
    const view = calls.find((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'view');
    expect(view[view.indexOf('--json') + 1].split(',')).toContain('isCrossRepository');
    expect(r.gate).toMatchObject({ action: 'not-started', code: 'cross-repository-head' });
    expect(spawned).toHaveLength(0);
    expect(fs.existsSync(path.join(root, STATE_SUBDIR))).toBe(false);
    expect(calls.some((c) => c[0] === 'git' && c.includes('fetch') && c.includes(HEAD))).toBe(false);
    expect(r.comment.action).toBe('created');
  });
});

describe('readPr', () => {
  const prWith = (over) => fakeRun({ 'pr view': ok({ headRefOid: HEAD, baseRefName: 'dev', state: 'OPEN', body: 'b', author: { login: 'a' }, isCrossRepository: false, ...over }) }).run;

  it('passes the fork answer through unchanged', async () => {
    expect(await deps({ run: prWith({ isCrossRepository: true }) }).readPr()).toMatchObject({ ok: true, isCrossRepository: true });
    expect(await deps({ run: prWith({}) }).readPr()).toMatchObject({ ok: true, isCrossRepository: false });
  });

  it('refuses a base branch that could be read as an option, that gh did not state, or that the gate would refuse', async () => {
    for (const baseRefName of ['--prune', '-x', '.hidden', 'a..b', 'x.lock', 'dev/', undefined, 42]) {
      expect((await deps({ run: prWith({ baseRefName }) }).readPr()).ok).toBe(false);
    }
    for (const baseRefName of ['dev', 'release/1.2', 'feat/a_b-c.d']) {
      expect((await deps({ run: prWith({ baseRefName }) }).readPr()).ok).toBe(true);
    }
  });
});

describe('readProtection classification', () => {
  const read = (answer) => deps({ run: fakeRun({ '/protection': answer }).run }).readProtection('dev');

  it('only GitHub\'s exact "Branch not protected" 404 means no rule', async () => {
    expect(await read(fail('gh: Branch not protected (HTTP 404)', JSON.stringify({ message: 'Branch not protected' })))).toEqual({ ok: true, notProtected: true });
  });
  it('a plain 404 (no access, or no such branch), a 403 and a network error are unreadable, never "no rule"', async () => {
    for (const answer of [
      fail('gh: Not Found (HTTP 404)', JSON.stringify({ message: 'Not Found' })),
      fail('gh: Resource not accessible (HTTP 403)', JSON.stringify({ message: 'Resource not accessible by integration' })),
      fail('dial tcp: no route to host'),
    ]) {
      expect((await read(answer)).ok).toBe(false);
    }
  });
  it('a successful read returns the rule; output that is not JSON is unreadable', async () => {
    expect((await read(ok({ required_pull_request_reviews: { required_approving_review_count: 2 } }))).protection.required_pull_request_reviews.required_approving_review_count).toBe(2);
    expect((await read(ok('<html>'))).ok).toBe(false);
  });
  it('refuses a branch name that could be an option or a path escape without calling gh', async () => {
    const { run, calls } = fakeRun({});
    expect((await deps({ run }).readProtection('--hostname=evil')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('our one comment', () => {
  const comments = (list) => deps({ run: fakeRun({ 'api user': ok({ login: 'Me' }), 'issues/9/comments': ok([list]) }).run }).findComment();

  it('finds the comment carrying the marker that the current gh login wrote (logins compare case-insensitively)', async () => {
    const r = await comments([{ id: 3, body: `${COMMENT_MARKER}\nx`, user: { login: 'me' } }]);
    expect(r.comment.id).toBe(3);
  });
  it('ignores a marker comment written by someone else: it cannot be edited and would hide that ours is missing', async () => {
    const r = await comments([{ id: 3, body: `${COMMENT_MARKER}\nforged`, user: { login: 'attacker' } }]);
    expect(r).toEqual({ ok: true, comment: null });
  });
  it('ignores our own comments that lack the marker at the start', async () => {
    expect((await comments([{ id: 4, body: `quoting ${COMMENT_MARKER}`, user: { login: 'me' } }])).comment).toBeNull();
  });
  it('picks the oldest when more than one exists, so it never adds another', async () => {
    const r = await comments([{ id: 9, body: COMMENT_MARKER, user: { login: 'me' } }, { id: 2, body: COMMENT_MARKER, user: { login: 'me' } }]);
    expect(r.comment.id).toBe(2);
  });
  it('fails closed when the current login cannot be read', async () => {
    const r = await deps({ run: fakeRun({ 'api user': fail('no auth') }).run }).findComment();
    expect(r.ok).toBe(false);
  });
  it('rejects updating a comment without a usable id', async () => {
    expect((await deps({ run: fakeRun({}).run }).updateComment('x', 'b')).ok).toBe(false);
  });
});

describe('main', () => {
  it('prints one redacted JSON object and exits 0 on success, 1 on a failed result or a bad payload', async () => {
    const out = [];
    const base = { write: (s) => out.push(s) };
    const goodDeps = {
      readPr: async () => ({ ok: true, headSha: HEAD, baseRefName: 'dev', state: 'OPEN', body: '', author: 'a' }),
      readReviews: async () => ({ ok: true, reviews: [] }),
      readHeadTree: async () => ({ ok: false }),
      readProtection: async () => ({ ok: false, error: `token ghp_${'A'.repeat(36)}` }),
      readStatuses: async () => ({ ok: true, statuses: [{ context: CONTEXT, state: 'success', sha: HEAD }] }),
      readGateConfig: async () => ({ ok: true, statusContext: CONTEXT }),
      readPolicy: async () => ({ ok: false }),
      findComment: async () => ({ ok: true, comment: null }),
      postComment: async () => ({ ok: true, id: 1, url: 'u' }),
    };
    expect(await main({ ...base, readJson: () => ({ repo: 'o/r', pr: 9, repoRoot: root }), deps: goodDeps })).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain('ghp_');
    expect(JSON.parse(out[0]).gate.action).toBe('status-present');

    out.length = 0;
    expect(await main({ ...base, readJson: () => ({ repo: 'o/r', pr: 9, repoRoot: root, nope: 1 }) })).toBe(1);
    expect(JSON.parse(out[0]).ok).toBe(false);

    out.length = 0;
    expect(await main({ ...base, readJson: () => ({ repo: 'o/r', pr: 9, repoRoot: root }), deps: { ...goodDeps, readPr: async () => ({ ok: false, error: 'gone' }) } })).toBe(1);
  });
});
