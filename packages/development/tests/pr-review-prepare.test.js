'use strict';

/**
 * Tests for the per-head preparation step (kata b1rv). Every test drives a REAL git repository built in a temp
 * directory and the real `git`/`tar`; only the baseline test command is pointed at `node --test` so no jest
 * install is needed. Each test names the guard it covers: removing that guard must make it fail.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { prepareReview, removePrepared, parseNumstatZ, defaultDeps } = require('../lib/pr-review-prepare');
const { main: cliMain } = require('../lib/pr-review-prepare-cli');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-prepare-cli.js');
const roots = [];
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const NODE_TEST = [process.execPath, '--test'];

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env } }).trim();
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const POLICY_BASE = '# Review\n\n```ensemble-review-policy\n{"sensitivePaths":["lib/**"]}\n```\n';
const POLICY_RELAXED = '# Review\n\n```ensemble-review-policy\n{"sensitivePaths":["nothing/**"]}\n```\n';

/**
 * base -> reviewed (R) -> head (H): R changes lib/thing.js; H is a remediation commit that changes it again and adds
 * awkward names, a binary file, a rename and a relaxed REVIEW.md. `refs/heads/pr` points at H.
 */
function makeFixture({ extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-fixture-'));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'REVIEW.md', POLICY_BASE);
  write(root, 'lib/thing.js', "module.exports = () => 'v0';\n");
  write(root, 'lib/old-name.js', 'module.exports = 1;\n');
  write(root, 'tests/thing.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\ntest('thing', () => { assert.strictEqual(require('../lib/thing.js')(), 'v0'); });\n");
  for (const [rel, content] of Object.entries(extra)) write(root, rel, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);

  write(root, 'lib/thing.js', "module.exports = () => 'v1';\n");
  git(root, ['commit', '-q', '-am', 'reviewed']);
  const reviewed = git(root, ['rev-parse', 'HEAD']);

  write(root, 'lib/thing.js', "module.exports = () => 'v2';\n");
  write(root, 'a b.txt', 'space\n');
  write(root, 'line\nbreak.txt', 'newline\n');
  write(root, 'tab\there.txt', 'tab\n');
  write(root, '\u00fcn\u00ef/caf\u00e9.txt', 'unicode\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
  git(root, ['mv', 'lib/old-name.js', 'lib/new-name.js']);
  write(root, 'REVIEW.md', POLICY_RELAXED);
  write(root, 'tests/thing.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('fs');\ntest('thing', () => { fs.writeFileSync('written-by-test.txt', 'x'); assert.strictEqual(require('../lib/thing.js')(), 'v2'); });\n");
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'remediation']);
  const head = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/heads/pr', head]);
  return { root, base, reviewed, head };
}

function opts(fx, overrides = {}) {
  return {
    repoRoot: fx.root,
    runId: 'run-1',
    baseSha: fx.base,
    headSha: fx.head,
    headRef: 'refs/heads/pr',
    lastReviewedSha: fx.reviewed,
    remediationShas: [fx.head],
    testCommand: NODE_TEST,
    nodeModules: path.join(fx.root, 'no-node-modules'),
    ...overrides,
  };
}

/** Real deps with every call recorded; `after(kind, args)` may act once a call returned (e.g. move a ref). */
function recordingDeps(after) {
  const real = defaultDeps();
  const calls = { git: [], run: [] };
  return {
    calls,
    git(args, o) { const r = real.git(args, o); calls.git.push(args); if (after) after('git', args, o); return r; },
    run(argv, o) { const r = real.run(argv, o); calls.run.push(argv); if (after) after('run', argv, o); return r; },
  };
}

/** Everything the step left behind: published heads of the run, plus any staging directory anywhere in the state root. */
function stateEntries(fx, runId = 'run-1') {
  const root = path.join(fx.root, '.ensemble', 'pr-review', 'prepare');
  const dir = path.join(root, runId);
  const staging = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('.staging-')) : [];
  return [...(fs.existsSync(dir) ? fs.readdirSync(dir) : []), ...staging];
}

afterAll(() => {
  for (const r of roots.splice(0)) removePrepared(r);
});

describe('prepareReview: one deterministic step per head (AC1)', () => {
  it('produces every artifact with a sha256 of its real content', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx));
    expect(r).toMatchObject({ ok: true, status: 'PREPARED', reused: false, mode: 'delta' });
    for (const name of ['range.diff', 'delta.diff', 'facts.json', 'probe.js', 'baseline.json', 'baseline.log']) {
      const a = r.artifacts[name];
      expect(a.path.startsWith(r.dir)).toBe(true);
      expect(a.sha256).toBe(sha256(fs.readFileSync(a.path)));
      expect(r.hashes[name]).toBe(a.sha256);
    }
    expect(r.artifacts.snapshot.treeSha).toBe(git(fx.root, ['rev-parse', `${fx.head}^{tree}`]));
    expect(r.manifestSha256).toBe(sha256(fs.readFileSync(r.manifestPath)));
    // the state directory is persistent and under the repo's ignored state tree, never a temp dir
    expect(r.dir).toBe(path.join(fx.root, '.ensemble', 'pr-review', 'prepare', 'run-1', fx.head));
  });

  it('range.diff is BASE...HEAD and delta.diff is lastReviewed..HEAD, byte for byte', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx));
    const flags = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/'];
    expect(fs.readFileSync(r.artifacts['range.diff'].path, 'utf8')).toBe(execFileSync('git', [...flags, `${fx.base}...${fx.head}`], { cwd: fx.root, encoding: 'utf8' }));
    const delta = fs.readFileSync(r.artifacts['delta.diff'].path, 'utf8');
    expect(delta).toBe(execFileSync('git', [...flags, `${fx.reviewed}..${fx.head}`], { cwd: fx.root, encoding: 'utf8' }));
    // the delta holds the remediation change only, never what the reviewed head already contained
    expect(delta).toContain("+module.exports = () => 'v2';");
    expect(delta).not.toContain("+module.exports = () => 'v1';");
  });

  it('the snapshot is a git-archive export of the head tree, not the live checkout', () => {
    const fx = makeFixture();
    write(fx.root, 'lib/thing.js', "module.exports = () => 'UNCOMMITTED';\n"); // the live worktree differs from the head
    const r = prepareReview(opts(fx));
    const snap = r.artifacts.snapshot.path;
    expect(fs.readFileSync(path.join(snap, 'lib/thing.js'), 'utf8')).toBe("module.exports = () => 'v2';\n");
    expect(fs.existsSync(path.join(snap, '.git'))).toBe(false);
  });

  it('re-running for the same head is a no-op that returns identical hashes and runs nothing', () => {
    const fx = makeFixture();
    const first = prepareReview(opts(fx));
    const deps = recordingDeps();
    const second = prepareReview(opts(fx), deps);
    expect(second.reused).toBe(true);
    expect(second.hashes).toEqual(first.hashes);
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(deps.calls.run).toEqual([]); // no baseline, no extraction
    expect(deps.calls.git.some((a) => a[0] === 'archive' || a[0] === 'diff')).toBe(false);
    expect(stateEntries(fx)).toEqual([fx.head]); // no staging leftovers, no second directory
  });

  it('a published artifact that no longer matches its recorded hash is rebuilt, never trusted', () => {
    const fx = makeFixture();
    const first = prepareReview(opts(fx));
    fs.writeFileSync(first.artifacts['range.diff'].path, 'tampered\n');
    const second = prepareReview(opts(fx));
    expect(second.reused).toBe(false);
    // everything derived from the repo is rebuilt identically (the baseline log carries the test runner's own timings)
    for (const name of ['snapshot', 'range.diff', 'delta.diff', 'facts.json', 'probe.js']) expect(second.hashes[name]).toBe(first.hashes[name]);
    expect(fs.readFileSync(second.artifacts['range.diff'].path, 'utf8')).not.toBe('tampered\n');
  });

  it('a snapshot file edited after publishing is detected and rebuilt', () => {
    const fx = makeFixture();
    const first = prepareReview(opts(fx));
    const target = path.join(first.artifacts.snapshot.path, 'lib/thing.js');
    fs.chmodSync(path.dirname(target), 0o755);
    fs.chmodSync(target, 0o644);
    fs.writeFileSync(target, 'poisoned\n');
    const second = prepareReview(opts(fx));
    expect(second.reused).toBe(false);
    expect(fs.readFileSync(path.join(second.artifacts.snapshot.path, 'lib/thing.js'), 'utf8')).toBe("module.exports = () => 'v2';\n");
  });

  it('different inputs for the same head (another base) are not served from the old directory', () => {
    const fx = makeFixture();
    prepareReview(opts(fx));
    const other = prepareReview(opts(fx, { baseSha: fx.reviewed, lastReviewedSha: undefined, remediationShas: undefined }));
    expect(other.reused).toBe(false);
    expect(other.baseSha).toBe(fx.reviewed);
    expect(other.mode).toBe('full');
  });
});

describe('prepareReview: fail closed (AC2)', () => {
  it('a head that moves during preparation is an error and publishes nothing', () => {
    const fx = makeFixture();
    // The author force-pushes while the baseline test run is in flight.
    const deps = recordingDeps((kind) => {
      if (kind === 'run') git(fx.root, ['update-ref', 'refs/heads/pr', fx.reviewed]);
    });
    const r = prepareReview(opts(fx), deps);
    expect(r).toMatchObject({ ok: false, status: 'PREPARE_FAILED', reason: 'head-moved' });
    expect(r.artifacts).toBeUndefined();
    expect(stateEntries(fx)).toEqual([]); // not even a staging directory survives
  });

  it('a head ref that is not the head being prepared is refused before any work', () => {
    const fx = makeFixture();
    git(fx.root, ['update-ref', 'refs/heads/pr', fx.reviewed]);
    const deps = recordingDeps();
    const r = prepareReview(opts(fx), deps);
    expect(r).toMatchObject({ ok: false, reason: 'head-mismatch' });
    expect(deps.calls.run).toEqual([]);
    expect(stateEntries(fx)).toEqual([]);
  });

  it('a head that moved after a successful preparation is an error even on the reuse path', () => {
    const fx = makeFixture();
    prepareReview(opts(fx));
    const deps = recordingDeps((kind, args) => {
      if (kind === 'git' && args[0] === 'ls-tree') git(fx.root, ['update-ref', 'refs/heads/pr', fx.reviewed]);
    });
    expect(prepareReview(opts(fx), deps)).toMatchObject({ ok: false, reason: 'head-moved' });
  });

  it('an unreadable base is an error', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx, { baseSha: 'd'.repeat(40), lastReviewedSha: undefined, remediationShas: undefined }));
    expect(r).toMatchObject({ ok: false, status: 'PREPARE_FAILED', reason: 'base-unreadable' });
    expect(stateEntries(fx)).toEqual([]);
  });

  it('an unreadable head is an error', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx, { headSha: 'e'.repeat(40), headRef: undefined, lastReviewedSha: undefined, remediationShas: undefined }));
    expect(r).toMatchObject({ ok: false, reason: 'head-unreadable' });
    expect(stateEntries(fx)).toEqual([]);
  });

  it('a ref name or abbreviated sha is not accepted as a sha', () => {
    const fx = makeFixture();
    expect(prepareReview(opts(fx, { baseSha: 'main' }))).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(prepareReview(opts(fx, { headSha: fx.head.slice(0, 10) }))).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(prepareReview(opts(fx, { runId: '' }))).toMatchObject({ ok: false, reason: 'invalid-input' });
  });

  it('a snapshot that is not exactly the head tree (export-ignore) fails instead of being close enough', () => {
    const fx = makeFixture({ extra: { '.gitattributes': 'lib/thing.js export-ignore\n' } });
    const r = prepareReview(opts(fx));
    expect(r).toMatchObject({ ok: false, reason: 'snapshot-mismatch', stage: 'snapshot' });
    expect(stateEntries(fx)).toEqual([]);
  });

  it('a baseline that cannot be started is an error, but a failing baseline is recorded with its exit code', () => {
    const fx = makeFixture();
    expect(prepareReview(opts(fx, { testCommand: ['/nonexistent/test-runner'] }))).toMatchObject({ ok: false, reason: 'baseline-not-run' });
    expect(stateEntries(fx)).toEqual([]);

    write(fx.root, 'tests/thing.test.js', "const test = require('node:test');\ntest('boom', () => { throw new Error('baseline-boom-marker'); });\n");
    git(fx.root, ['commit', '-q', '-am', 'break test']);
    const head = git(fx.root, ['rev-parse', 'HEAD']);
    const r = prepareReview(opts(fx, { headSha: head, headRef: undefined, lastReviewedSha: undefined, remediationShas: undefined }));
    expect(r.ok).toBe(true);
    expect(r.baseline).toMatchObject({ ran: true, exitCode: 1, timedOut: false });
    expect(fs.readFileSync(r.artifacts['baseline.log'].path, 'utf8')).toContain('baseline-boom-marker');
  });

  it('a runId cannot steer the run directory out of the state root', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx, { runId: '../../../escape' }));
    expect(r.ok).toBe(true);
    const root = path.join(fx.root, '.ensemble', 'pr-review', 'prepare');
    expect(r.dir.startsWith(root + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(fx.root, '..', 'escape'))).toBe(false);
  });
});

describe('changedPaths is NUL-delimited and rename-safe (AC3)', () => {
  it('lists spaces, newline, tab, unicode, a binary file and BOTH sides of a rename verbatim', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx, { lastReviewedSha: undefined, remediationShas: undefined }));
    const facts = JSON.parse(fs.readFileSync(r.artifacts['facts.json'].path, 'utf8'));
    expect(facts.changedPaths).toEqual([
      'REVIEW.md',
      'a b.txt',
      'blob.bin',
      'lib/new-name.js',
      'lib/old-name.js',
      'lib/thing.js',
      'line\nbreak.txt',
      'tab\there.txt',
      'tests/thing.test.js',
      '\u00fcn\u00ef/caf\u00e9.txt',
    ]);
    expect(facts.numstat.find((f) => f.path === 'blob.bin')).toEqual({ path: 'blob.bin', added: null, deleted: null, binary: true });
    expect(facts.numstat.find((f) => f.path === 'lib/old-name.js')).toMatchObject({ added: 0, deleted: 1 });
    expect(facts.totals.binary).toBe(1);
  });

  it('parseNumstatZ keeps a path with tabs and newlines whole and refuses output it cannot read', () => {
    expect(parseNumstatZ('1\t2\ta\tb\nc\0')).toEqual([{ path: 'a\tb\nc', added: 1, deleted: 2, binary: false }]);
    expect(() => parseNumstatZ('1\t2\tno-terminator')).toThrow();
    expect(() => parseNumstatZ('x\ty\tp\0')).toThrow();
  });
});

describe('delta.diff is absent with a reason unless review-range says delta (AC4)', () => {
  it('first round: no delta.diff, reason first-round', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx, { lastReviewedSha: undefined, remediationShas: undefined }));
    expect(r.mode).toBe('full');
    expect(r.absent).toEqual({ 'delta.diff': 'first-round' });
    expect(r.artifacts['delta.diff']).toBeUndefined();
    expect(fs.existsSync(path.join(r.dir, 'delta.diff'))).toBe(false);
  });

  it('a commit nobody vouched for as remediation forces the full range: no delta.diff', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx, { remediationShas: [] }));
    expect(r.mode).toBe('full');
    expect(r.absent['delta.diff']).toBe('unvouched-history');
    expect(fs.existsSync(path.join(r.dir, 'delta.diff'))).toBe(false);
  });

  it('a reviewed head that is not an ancestor (force-push) forces the full range', () => {
    const fx = makeFixture();
    git(fx.root, ['checkout', '-q', '-b', 'side', fx.base]);
    write(fx.root, 'side.txt', 's\n');
    git(fx.root, ['add', '-A']);
    git(fx.root, ['commit', '-q', '-m', 'side']);
    const side = git(fx.root, ['rev-parse', 'HEAD']);
    const r = prepareReview(opts(fx, { lastReviewedSha: side }));
    expect(r.mode).toBe('full');
    expect(fs.existsSync(path.join(r.dir, 'delta.diff'))).toBe(false);
  });

  it('an unchanged head is a delta with an empty delta.diff', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx, { lastReviewedSha: fx.head }));
    expect(r.mode).toBe('delta');
    expect(fs.readFileSync(r.artifacts['delta.diff'].path, 'utf8')).toBe('');
  });
});

describe('facts.json', () => {
  it('reads policy and CODEOWNERS from the BASE commit, never the head that relaxed them', () => {
    const fx = makeFixture({ extra: { '.github/CODEOWNERS': 'lib/** @team/core\n' } });
    const r = prepareReview(opts(fx, { lastReviewedSha: undefined, remediationShas: undefined }));
    const facts = JSON.parse(fs.readFileSync(r.artifacts['facts.json'].path, 'utf8'));
    expect(facts.policy.source).toBe('policy');
    expect(facts.policy.policy.sensitivePaths).toEqual(['lib/**']); // the head's REVIEW.md says ["nothing/**"]
    expect(facts.paths.sensitive).toContain('lib/thing.js');
    expect(facts.pathsInput.declaration.sourceSha).toBe(fx.base);
    expect(facts.pathsInput.codeowners).toBe('lib/** @team/core\n');
    expect(facts.guidance).toMatchObject({ sourceSha: fx.base, rulesFilePresent: true, codeownersPath: '.github/CODEOWNERS' });
    expect(facts.tierInputs.paths).toEqual(facts.paths);
    expect(facts.tierInputs.kinds).toBeNull();
    expect(facts).toMatchObject({ baseSha: fx.base, headSha: fx.head, range: { mode: 'full' } });
  });

  it('a base with no REVIEW.md yields the defaults, said so, not an error', () => {
    const fx = makeFixture();
    git(fx.root, ['rm', '-q', '--cached', 'REVIEW.md']);
    git(fx.root, ['commit', '-q', '-m', 'drop review']);
    const nextBase = git(fx.root, ['rev-parse', 'HEAD']);
    write(fx.root, 'x.txt', 'x\n');
    git(fx.root, ['add', 'x.txt']);
    git(fx.root, ['commit', '-q', '-m', 'more']);
    const head = git(fx.root, ['rev-parse', 'HEAD']);
    const r = prepareReview(opts(fx, { baseSha: nextBase, headSha: head, headRef: undefined, lastReviewedSha: undefined, remediationShas: undefined }));
    const facts = JSON.parse(fs.readFileSync(r.artifacts['facts.json'].path, 'utf8'));
    expect(facts.guidance.rulesFilePresent).toBe(false);
    expect(facts.policy).toMatchObject({ ok: true, source: 'defaults' });
  });
});

describe('the snapshot is never written to', () => {
  it('is read-only once published, and the baseline run happens on a scratch copy', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx));
    const snap = r.artifacts.snapshot.path;
    // the changed test writes a file into its cwd; it must not land in the reviewed snapshot
    expect(fs.existsSync(path.join(snap, 'written-by-test.txt'))).toBe(false);
    expect(r.baseline).toMatchObject({ ran: true, exitCode: 0 });
    expect(fs.existsSync(path.join(r.dir, '.baseline-work'))).toBe(false);
    if (process.getuid && process.getuid() !== 0) {
      expect(() => fs.writeFileSync(path.join(snap, 'lib/thing.js'), 'x')).toThrow(/EACCES|EPERM/);
      expect(() => fs.writeFileSync(path.join(snap, 'new-file.txt'), 'x')).toThrow(/EACCES|EPERM/);
    }
    expect(prepareReview(opts(fx)).reused).toBe(true); // and a re-verify finds it unchanged
  });

  it('runs the changed tests and the tests of changed sources, and records why', () => {
    const fx = makeFixture();
    const r = prepareReview(opts(fx));
    const baseline = JSON.parse(fs.readFileSync(r.artifacts['baseline.json'].path, 'utf8'));
    expect(baseline.selection).toEqual([{ file: 'tests/thing.test.js', why: 'changed' }]);
    expect(baseline.command.slice(-1)).toEqual(['--test']);
  });

  it('records that no test file was relevant instead of pretending a run happened', () => {
    const fx = makeFixture();
    write(fx.root, 'docs.md', 'doc\n');
    git(fx.root, ['add', 'docs.md']);
    git(fx.root, ['commit', '-q', '-m', 'docs']);
    const head = git(fx.root, ['rev-parse', 'HEAD']);
    const r = prepareReview(opts(fx, { baseSha: fx.head, headSha: head, headRef: undefined, lastReviewedSha: undefined, remediationShas: undefined }));
    expect(r.baseline).toMatchObject({ ran: false, reason: 'no-test-files', exitCode: null });
  });
});

describe('probe.js: the ready probe runner', () => {
  it('loads head modules, resolves third-party requires, runs read-only and chains steps, in a fresh process', () => {
    const nm = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-nm-'));
    roots.push(nm);
    write(nm, 'fakedep/index.js', "module.exports = 'fakedep-ok';\n");
    const fx = makeFixture({ extra: { 'lib/uses-dep.js': "module.exports = require('fakedep');\n" } });
    const r = prepareReview(opts(fx, { nodeModules: nm }));
    const script = `
      const probe = require(${JSON.stringify(r.artifacts['probe.js'].path)});
      const out = {
        thing: probe.load('lib/thing.js')(),
        dep: probe.load('lib/uses-dep.js'),
        atBase: probe.readAtBase('lib/thing.js'),
        missingAtBase: probe.readAtBase('nope.txt'),
        head: probe.facts.headSha,
        write: probe.run([process.execPath, '-e', "require('fs').writeFileSync('probe-wrote.txt','x')"]).status,
        chain: probe.chain([
          { name: 'a', run: () => 1 },
          { name: 'b', run: (c) => c.results.a + 1 },
          { name: 'c', run: () => { throw new Error('boom'); } },
          { name: 'd', run: () => 'never' },
        ]),
      };
      try { probe.load('../../escape.js'); out.escape = 'allowed'; } catch (e) { out.escape = e.message; }
      process.stdout.write(JSON.stringify(out));
    `;
    const p = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(p.stderr).toBe('');
    const out = JSON.parse(p.stdout);
    expect(out.thing).toBe('v2');
    expect(out.dep).toBe('fakedep-ok');
    expect(out.atBase).toBe("module.exports = () => 'v0';\n");
    expect(out.missingAtBase).toBeNull();
    expect(out.head).toBe(fx.head);
    expect(out.write).not.toBe(0); // the snapshot is read-only
    expect(fs.existsSync(path.join(r.artifacts.snapshot.path, 'probe-wrote.txt'))).toBe(false);
    expect(out.chain).toEqual({
      ok: false,
      steps: [{ name: 'a', ok: true, value: 1 }, { name: 'b', ok: true, value: 2 }, { name: 'c', ok: false, error: 'boom' }],
    });
    expect(out.escape).toMatch(/escapes the snapshot/);
  });
});

describe('entry point', () => {
  it('prepares a head from a JSON payload on stdin and reports the wall time; the second run reuses', () => {
    const fx = makeFixture();
    const payload = JSON.stringify(opts(fx));
    const run = () => spawnSync(process.execPath, [CLI], { input: payload, encoding: 'utf8', cwd: os.homedir() });
    const first = run();
    expect(first.status).toBe(0);
    const a = JSON.parse(first.stdout);
    expect(a).toMatchObject({ ok: true, reused: false, headSha: fx.head });
    expect(typeof a.wallMs).toBe('number');
    const second = JSON.parse(run().stdout);
    expect(second.reused).toBe(true);
    expect(second.hashes).toEqual(a.hashes);
  });

  it('exits 1 with an error object for a failed preparation and for unreadable JSON', () => {
    const fx = makeFixture();
    const bad = spawnSync(process.execPath, [CLI], { input: JSON.stringify(opts(fx, { baseSha: 'd'.repeat(40) })), encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, reason: 'base-unreadable' });

    const emitted = [];
    expect(cliMain({ readJson: () => { throw new Error('nope'); }, emit: (v) => emitted.push(v) })).toBe(1);
    expect(emitted[0]).toMatchObject({ ok: false, reason: 'invalid-input' });
  });
});
