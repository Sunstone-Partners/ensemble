'use strict';
/**
 * Tests for the findings-as-beads tracker capabilities (kata yfbg):
 *   - packages/development/lib/tracker-findings.js (find-by-key verdicts, validation, the
 *     defined "unavailable" result), driven with injected deps;
 *   - the REAL beads adapter manifest through the REAL runner against a replay `br` that prints
 *     outputs CAPTURED LIVE from br 0.6.0 (scripts/tests/fixtures/toolchain/
 *     adapter-tracker-beads-samples/), so a wrong `root`/`map` or a wrong argv flag fails here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { runCapabilitySync } = require('../../packages/development/lib/toolchain/runner');
const findings = require('../../packages/development/lib/tracker-findings');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SAMPLES = path.join(__dirname, 'fixtures', 'toolchain', 'adapter-tracker-beads-samples');
const TRACKER_CONTRACT = path.join(REPO_ROOT, 'packages', 'development', 'toolchain', 'categories', 'tracker.yaml');
const { manifest: BEADS } = loadAdapter('beads', { projectRoot: REPO_ROOT });

const FINDING_CAPABILITIES = [
  'tracker.create-detailed',
  'tracker.find-by-key',
  'tracker.update-detailed',
  'tracker.close-with-reason'
];

const sample = (name) => fs.readFileSync(path.join(SAMPLES, name), 'utf8');

// ---------------------------------------------------------------------------
// Replay br: prints a captured fixture and records the argv it was called with.
// ---------------------------------------------------------------------------

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** @param {Record<string,string>} replay first-argv-word (or "dep add") -> fixture file name */
function replayBr(replay) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-findings-')));
  tempDirs.push(dir);
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(argv) + '\\n');
const replay = JSON.parse(fs.readFileSync(path.join(__dirname, 'replay.json'), 'utf8'));
const key = argv[0] === 'dep' ? 'dep ' + argv[1] : argv[0];
if (!(key in replay)) { process.stderr.write('replay br: no fixture for ' + key + '\\n'); process.exit(2); }
process.stdout.write(fs.readFileSync(replay[key], 'utf8'));
`;
  fs.writeFileSync(path.join(dir, 'br'), script, { mode: 0o755 });
  const full = Object.fromEntries(Object.entries(replay).map(([k, v]) => [k, path.join(SAMPLES, v)]));
  fs.writeFileSync(path.join(dir, 'replay.json'), JSON.stringify(full));
  const calls = () =>
    fs.existsSync(path.join(dir, 'argv.log'))
      ? fs.readFileSync(path.join(dir, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  return { dir, calls, env };
}

function deps(replay, manifest = BEADS, categoriesDir) {
  const br = replayBr(replay);
  return {
    br,
    run: (capability, args) =>
      runCapabilitySync(manifest, capability, args, { parentEnv: br.env, timeoutMs: 10000, categoriesDir })
  };
}

// ---------------------------------------------------------------------------
// Contract: optional + fallback (the guard that makes "unavailable" structured)
// ---------------------------------------------------------------------------

describe('tracker category contract: findings capabilities degrade, never become required', () => {
  const contract = yaml.load(fs.readFileSync(TRACKER_CONTRACT, 'utf8')).capabilities;

  test.each(FINDING_CAPABILITIES)('%s is optional and declares the skip fallback', (id) => {
    expect(contract[id]).toBeDefined();
    expect(contract[id].required).toBe(false);
    expect(contract[id].fallback).toBe(findings.SKIP_FALLBACK);
  });

  test.each(FINDING_CAPABILITIES)('the beads adapter declares %s', (id) => {
    expect(BEADS.capabilities[id]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Real manifest + real runner + captured br output
// ---------------------------------------------------------------------------

describe('beads adapter parses real captured br output', () => {
  test('tracker.create: a bare object (NOT array-of-one) yields the new id', () => {
    const { run, br } = deps({ create: 'br-create-plain.sample.json' });
    const result = run('tracker.create', { title: 't', description: 'd', type: 'task' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: JSON.parse(sample('br-create-plain.sample.json')).id });
    expect(br.calls()[0]).toEqual(['create', '--title', 't', '--type', 'task', '-d', 'd', '--json']);
  });

  test('tracker.create-detailed: passes labels, priority and external ref in ONE create call', () => {
    const { run, br } = deps({ create: 'br-create-detailed.sample.json' });
    const result = run('tracker.create-detailed', {
      title: 'Finding',
      description: 'claim',
      type: 'bug',
      labels: 'pr-review,sev-important',
      priority: '1',
      externalKey: 'dk:acme/repo:src/a.js:unchecked-path'
    });
    expect(result.ok).toBe(true);
    expect(result.data.id).toBe(JSON.parse(sample('br-create-detailed.sample.json')).id);
    expect(br.calls()).toEqual([
      [
        'create', '--title', 'Finding', '--type', 'bug', '-d', 'claim',
        '-l', 'pr-review,sev-important', '-p', '1',
        '--external-ref', 'dk:acme/repo:src/a.js:unchecked-path', '--json'
      ]
    ]);
  });

  test('tracker.update-detailed: rewrites fields and APPENDS notes (never --notes, which replaces)', () => {
    const { run, br } = deps({ update: 'br-update-detailed.sample.json' });
    const result = run('tracker.update-detailed', {
      id: 'ws-17y', title: 'T', description: 'D', priority: '0', notes: 'head def5678: 3/3 real'
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'ws-17y' });
    const argv = br.calls()[0];
    expect(argv).toContain('--append-notes');
    expect(argv).not.toContain('--notes');
    // Labels and status are deliberately not touched by a re-review update.
    for (const flag of ['--add-label', '--set-labels', '--remove-label', '--status', '-s']) {
      expect(argv).not.toContain(flag);
    }
  });

  test('tracker.close-with-reason: records the reason and the commit, normalizes status to closed', () => {
    const { run, br } = deps({ close: 'br-close-with-reason.sample.json' });
    const result = run('tracker.close-with-reason', { id: 'ws-17y', reason: 'fixed by author', commit: 'def5678' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'ws-17y', status: 'closed' });
    expect(br.calls()[0]).toEqual([
      'close', 'ws-17y', '--reason', 'fixed by author',
      '--transition-comment', 'closed at commit def5678', '--json'
    ]);
  });

  test.each([
    ['tracker.dep-add', { id: 'a', dependsOnId: 'b', type: 'blocks' }, 'dep add', 'br-dep-add.sample.json'],
    ['tracker.dep-remove', { id: 'a', dependsOnId: 'b' }, 'dep remove', 'br-dep-remove.sample.json']
  ])('%s: the real shape (bare object keyed by issue_id, no id field) maps to the issue id', (cap, args, key, file) => {
    const { run } = deps({ [key]: file });
    const result = run(cap, args);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: JSON.parse(sample(file)).issue_id });
  });
});

// ---------------------------------------------------------------------------
// findByKey: zero / one / many against captured `br list` output
// ---------------------------------------------------------------------------

describe('findByKey (AC3)', () => {
  const LIST = JSON.parse(sample('br-list-by-label.sample.json'));
  const KEY_A = 'dk:acme/repo:src/a.js:unchecked-path';

  test('exactly one bead for a key present once in the real captured list', () => {
    const { run, br } = deps({ list: 'br-list-by-label.sample.json' });
    const result = findings.findByKey({ run }, { key: KEY_A, label: 'pr-review' });
    expect(result).toMatchObject({ ok: true, found: true });
    expect(result.item.external_ref).toBe(KEY_A);
    expect(LIST.issues.length).toBeGreaterThan(1); // the other bead must NOT be returned
    expect(br.calls()[0]).toEqual(['list', '--all', '--limit', '0', '--label', 'pr-review', '--json']);
  });

  test('none for an absent key, and a key that is only a prefix of a real one', () => {
    const { run } = deps({ list: 'br-list-by-label.sample.json' });
    expect(findings.findByKey({ run }, { key: 'dk:acme/repo:src/zzz.js:nope', label: 'pr-review' })).toEqual({ ok: true, found: false });
    expect(findings.findByKey({ run }, { key: 'dk:acme/repo:src/a.js', label: 'pr-review' })).toEqual({ ok: true, found: false });
  });

  test('refuses (AMBIGUOUS_KEY, naming the ids) when several beads share the key', () => {
    const dup = { issues: [{ id: 'b-1', external_ref: 'k' }, { id: 'b-2', external_ref: 'k' }, { id: 'b-3', external_ref: 'other' }] };
    const run = () => ({ ok: true, data: JSON.stringify(dup) });
    const result = findings.findByKey({ run }, { key: 'k', label: 'pr-review' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('AMBIGUOUS_KEY');
    expect(result.error.ids).toEqual(['b-1', 'b-2']);
    expect(result.found).toBeUndefined();
  });

  test('an empty key never matches beads that have no key', () => {
    const run = jest.fn(() => ({ ok: true, data: JSON.stringify({ issues: [{ id: 'b-1' }, { id: 'b-2', external_ref: '' }] }) }));
    const result = findings.findByKey({ run }, { key: '', label: 'pr-review' });
    expect(result.error.code).toBe('INVALID_ARG');
    expect(run).not.toHaveBeenCalled();
  });

  test('accepts an older br bare-array list and refuses unparseable output', () => {
    expect(findings.findByKey({ run: () => ({ ok: true, data: '[{"id":"b-1","external_ref":"k"}]' }) }, { key: 'k', label: 'x' }))
      .toMatchObject({ ok: true, found: true });
    expect(findings.findByKey({ run: () => ({ ok: true, data: 'not json' }) }, { key: 'k', label: 'x' }).error.code).toBe('BAD_OUTPUT');
    expect(findings.findByKey({ run: () => ({ ok: true, data: '{"nope":1}' }) }, { key: 'k', label: 'x' }).error.code).toBe('BAD_OUTPUT');
  });
});

// ---------------------------------------------------------------------------
// AC4: no tracker / capability absent -> defined unavailable result, never a throw
// ---------------------------------------------------------------------------

describe('unavailable result (AC4)', () => {
  const ARGS = {
    createFinding: [{ title: 't', description: 'd', labels: ['pr-review'], priority: 1, key: 'k' }],
    findByKey: [{ key: 'k', label: 'pr-review' }],
    updateFinding: [{ id: 'b-1', title: 't', description: 'd', priority: 1, note: 'n' }],
    closeFinding: [{ id: 'b-1', reason: 'r', commit: 'abc1234' }]
  };
  const UNAVAILABLE = {
    ok: false,
    unavailable: true,
    fallback: 'skip-finding-beads',
    error: { code: 'UNAVAILABLE', message: expect.any(String) }
  };

  // An adapter that declares NONE of the findings capabilities (any non-beads tracker).
  const BARE_ADAPTER = { adapter: 'bare', binaries: [], allowlist: [], capabilities: {} };

  test.each(Object.keys(ARGS))('%s: adapter without the capability -> structured unavailable from the real runner', (fn) => {
    const run = (capability, args) => runCapabilitySync(BARE_ADAPTER, capability, args, {});
    expect(findings[fn]({ run }, ...ARGS[fn])).toEqual(UNAVAILABLE);
  });

  test.each(Object.keys(ARGS))('%s: an older contract with no fallback (NOT_ALLOWED undeclared) is also unavailable', (fn) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-findings-contract-')));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tracker.yaml'), 'category: tracker\nversion: "1.0"\ncapabilities: {}\n');
    const run = (capability, args) => runCapabilitySync(BARE_ADAPTER, capability, args, { categoriesDir: dir });
    expect(findings[fn]({ run }, ...ARGS[fn])).toEqual(UNAVAILABLE);
  });

  test.each(Object.keys(ARGS))('%s: a tracker that cannot be resolved (run throws) is unavailable, not an exception', (fn) => {
    const run = () => { throw new Error('no tracker adapter configured'); };
    expect(() => findings[fn]({ run }, ...ARGS[fn])).not.toThrow();
    expect(findings[fn]({ run }, ...ARGS[fn])).toEqual(UNAVAILABLE);
  });

  test.each(Object.keys(ARGS))('%s: tracker binary not installed (real ENOENT) is unavailable', (fn) => {
    const run = (capability, args) =>
      runCapabilitySync(BEADS, capability, args, { parentEnv: { PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'tf-empty-')) } });
    expect(findings[fn]({ run }, ...ARGS[fn])).toEqual(UNAVAILABLE);
  });

  test('a genuine tool failure is NOT swallowed as unavailable', () => {
    const run = () => ({ ok: false, error: { code: 'TOOL_FAILED', message: 'beads: capability failed: database is locked' } });
    const result = findings.createFinding({ run }, ...ARGS.createFinding);
    expect(result.unavailable).toBeUndefined();
    expect(result.error.code).toBe('TOOL_FAILED');
  });

  test('createToolchainDeps: a repository with no initialised tracker workspace is unavailable and runs nothing', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-findings-repo-')));
    tempDirs.push(repo);
    const br = replayBr({ list: 'br-list-by-label.sample.json' });
    const result = findings.findByKey(
      findings.createToolchainDeps({ projectRoot: repo, env: br.env }),
      { key: 'k', label: 'pr-review' }
    );
    expect(result).toEqual(UNAVAILABLE);
    expect(br.calls()).toEqual([]);
  });

  test('createToolchainDeps: with a .beads workspace the same call reaches br in that directory', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-findings-repo-')));
    tempDirs.push(repo);
    fs.mkdirSync(path.join(repo, '.beads'));
    const br = replayBr({ list: 'br-list-by-label.sample.json' });
    const result = findings.findByKey(
      findings.createToolchainDeps({ projectRoot: repo, env: br.env }),
      { key: 'dk:acme/repo:src/a.js:unchecked-path', label: 'pr-review' }
    );
    expect(result).toMatchObject({ ok: true, found: true });
    expect(br.calls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Input guards: refuse before any tracker call
// ---------------------------------------------------------------------------

describe('input validation refuses without calling the tracker', () => {
  const ok = { title: 't', description: 'd', labels: ['pr-review'], priority: 1, key: 'k' };
  const cases = [
    ['createFinding', { ...ok, key: '' }],
    ['createFinding', { ...ok, labels: [] }],
    ['createFinding', { ...ok, labels: ['a,b'] }],
    ['createFinding', { ...ok, priority: 5 }],
    ['createFinding', { ...ok, title: ' ' }],
    ['updateFinding', { id: 'b-1', title: 't', description: 'd', priority: 1, note: '' }],
    ['updateFinding', { id: 'b-1', title: 't', description: 'd', priority: -1, note: 'n' }],
    ['closeFinding', { id: 'b-1', reason: '   ', commit: 'abc1234' }],
    ['closeFinding', { id: 'b-1', reason: 'r', commit: 'not-a-sha' }],
    ['closeFinding', { id: 'b-1', reason: 'r' }]
  ];

  test.each(cases)('%s(%j) -> INVALID_ARG', (fn, input) => {
    const run = jest.fn();
    const result = findings[fn]({ run }, input);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARG');
    expect(run).not.toHaveBeenCalled();
  });
});
