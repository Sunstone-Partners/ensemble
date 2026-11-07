'use strict';

/**
 * pr-review-carry-hash.js / pr-review-carry-hash-cli.js (kata qw98) against REAL git repositories. Fixtures live under
 * ~/.omp/pr-review-speedup/qw98/fixtures (never os.tmpdir()). Every test names the guard it covers: remove that guard and
 * the test fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { hashCitations } = require('../lib/pr-review-carry-hash');
const { main } = require('../lib/pr-review-carry-hash-cli');
const { planCarry, REASONS } = require('../lib/pr-review-carry');

const FIXTURE_ROOT = path.join(os.homedir(), '.omp', 'pr-review-speedup', 'qw98', 'fixtures');
const roots = [];

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A repo with one commit holding `files`; returns { root, commit(files) -> sha, head }. */
function makeRepo(files) {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'repo-'));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  const commit = (changes) => {
    for (const [rel, content] of Object.entries(changes)) {
      if (content === null) fs.rmSync(path.join(root, rel), { force: true });
      else write(root, rel, content);
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '--allow-empty', '-m', 'c']);
    return git(root, ['rev-parse', 'HEAD']);
  };
  const head = commit(files);
  return { root, commit, head };
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const lines = (n, mark = {}) => Array.from({ length: n }, (_, i) => mark[i + 1] || `// line ${i + 1}`).join('\n') + '\n';
const one = (repo, headSha, citation) => {
  const out = hashCitations({ repoRoot: repo.root, headSha, citations: [citation] });
  expect(out.ok).toBe(true);
  return out.candidates[0];
};
const SHA = /^[0-9a-f]{64}$/;

describe('hunkHash', () => {
  const repo = makeRepo({ 'src/a.js': lines(30) });

  test('is stable across calls and returns the citation verbatim', () => {
    const citation = { id: 'F1', file: 'src/a.js', line: 15, claim: 'x is wrong' };
    const first = one(repo, repo.head, citation);
    const second = one(repo, repo.head, citation);
    expect(first).toEqual(second);
    expect(first).toMatchObject(citation);
    expect(first.hunkHash).toMatch(SHA);
    expect(first.depHashes).toEqual({});
  });

  test('a change inside the cited region plus 3 lines of context changes it; 4+ lines away does not', () => {
    const base = one(repo, repo.head, { file: 'src/a.js', line: 15 }).hunkHash;
    const inside = repo.commit({ 'src/a.js': lines(30, { 18: '// changed' }) }); // line 18 = cited + 3
    expect(one(repo, inside, { file: 'src/a.js', line: 15 }).hunkHash).not.toBe(base);
    const outside = repo.commit({ 'src/a.js': lines(30, { 19: '// changed' }) }); // cited + 4
    expect(one(repo, outside, { file: 'src/a.js', line: 15 }).hunkHash).toBe(base);
    const above = repo.commit({ 'src/a.js': lines(30, { 11: '// changed' }) }); // cited - 4
    expect(one(repo, above, { file: 'src/a.js', line: 15 }).hunkHash).toBe(base);
    const lineAbove = repo.commit({ 'src/a.js': lines(30, { 12: '// changed' }) }); // cited - 3
    expect(one(repo, lineAbove, { file: 'src/a.js', line: 15 }).hunkHash).not.toBe(base);
    repo.commit({ 'src/a.js': lines(30) });
  });

  test('a `lines` range is the same region as its endpoints, and clamps context to the file', () => {
    const range = one(repo, repo.head, { file: 'src/a.js', lines: [10, 12] }).hunkHash;
    const edit = repo.commit({ 'src/a.js': lines(30, { 9: '// changed' }) });
    expect(one(repo, edit, { file: 'src/a.js', lines: [10, 12] }).hunkHash).not.toBe(range);
    const edge = one(repo, repo.head, { file: 'src/a.js', line: 1 });
    expect(edge.hunkHash).toMatch(SHA);
    expect(one(repo, repo.head, { file: 'src/a.js', line: 30 }).hunkHash).toMatch(SHA);
    repo.commit({ 'src/a.js': lines(30) });
  });

  test('reads the commit, not the working tree', () => {
    const before = one(repo, repo.head, { file: 'src/a.js', line: 15 });
    write(repo.root, 'src/a.js', lines(30, { 15: '// DIRTY' }));
    write(repo.root, 'src/untracked-dep.js', 'x');
    try {
      expect(one(repo, repo.head, { file: 'src/a.js', line: 15 })).toEqual(before);
    } finally {
      git(repo.root, ['checkout', '--', 'src/a.js']);
    }
  });

  test.each([
    ['no line or range', { file: 'src/a.js' }],
    ['line and lines together', { file: 'src/a.js', line: 3, lines: [3, 4] }],
    ['range past the end of the file', { file: 'src/a.js', lines: [28, 31] }],
    ['line 0', { file: 'src/a.js', line: 0 }],
    ['reversed range', { file: 'src/a.js', lines: [5, 4] }],
    ['non-integer line', { file: 'src/a.js', line: 2.5 }],
    ['file absent at head', { file: 'src/missing.js', line: 1 }],
    ['path escaping the repository', { file: '../a.js', line: 1 }],
  ])('%s => hashError and no hash fields', (_name, citation) => {
    const out = one(repo, repo.head, citation);
    expect(typeof out.hashError).toBe('string');
    expect(out).not.toHaveProperty('hunkHash');
    expect(out).not.toHaveProperty('depHashes');
  });

  test('a file that exists only in the working tree, not at the head, is absent', () => {
    write(repo.root, 'src/new.js', lines(5));
    try {
      expect(one(repo, repo.head, { file: 'src/new.js', line: 1 }).hashError).toMatch(/does not exist/);
    } finally {
      fs.rmSync(path.join(repo.root, 'src/new.js'));
    }
  });
});

describe('depHashes', () => {
  const FILES = {
    'src/a.js': "const b = require('./b');\nconst c = require('../lib/c.json');\n" + lines(10),
    'src/b.js': "import d from './deep/d.js';\nmodule.exports = 1;\n",
    'src/deep/d.js': "module.exports = 'd';\n",
    'lib/c.json': '{"v":1}\n',
    'docs/readme.md': "# doc\nsee require('./nothing') in prose\n",
    'src/unrelated.js': 'module.exports = 0;\n',
  };
  const repo = makeRepo(FILES);
  const base = one(repo, repo.head, { file: 'src/a.js', line: 5 });

  test('holds the transitive closure (direct, nested, json) and never the cited file itself', () => {
    expect(Object.keys(base.depHashes).sort()).toEqual(['lib/c.json', 'src/b.js', 'src/deep/d.js']);
    for (const hash of Object.values(base.depHashes)) expect(hash).toMatch(SHA);
  });

  test('changing a direct dependency changes depHashes', () => {
    const next = repo.commit({ 'src/b.js': "import d from './deep/d.js';\nmodule.exports = 2;\n" });
    const after = one(repo, next, { file: 'src/a.js', line: 5 });
    expect(after.depHashes['src/b.js']).not.toBe(base.depHashes['src/b.js']);
    expect(after.depHashes['src/deep/d.js']).toBe(base.depHashes['src/deep/d.js']);
    expect(after.hunkHash).toBe(base.hunkHash);
    repo.commit({ 'src/b.js': FILES['src/b.js'] });
  });

  test('changing a TRANSITIVE dependency changes depHashes', () => {
    const next = repo.commit({ 'src/deep/d.js': "module.exports = 'changed';\n" });
    const after = one(repo, next, { file: 'src/a.js', line: 5 });
    expect(after.depHashes['src/deep/d.js']).not.toBe(base.depHashes['src/deep/d.js']);
    expect(after.depHashes['src/b.js']).toBe(base.depHashes['src/b.js']);
    repo.commit({ 'src/deep/d.js': FILES['src/deep/d.js'] });
  });

  test('adding an import changes the key set; an unrelated change does not', () => {
    const added = repo.commit({ 'src/a.js': FILES['src/a.js'] + "require('./unrelated');\n" });
    expect(Object.keys(one(repo, added, { file: 'src/a.js', line: 5 }).depHashes)).toContain('src/unrelated.js');
    const unrelated = repo.commit({ 'src/a.js': FILES['src/a.js'], 'src/unrelated.js': 'module.exports = 9;\n' });
    expect(one(repo, unrelated, { file: 'src/a.js', line: 5 }).depHashes).toEqual(base.depHashes);
  });

  test('resolves an index file and a compiled-extension specifier to the tracked file', () => {
    const r = makeRepo({
      'a.ts': "import x from './pkg';\nimport y from './y.js';\n",
      'pkg/index.js': 'export default 1;\n',
      'y.ts': 'export default 2;\n',
    });
    expect(Object.keys(one(r, r.head, { file: 'a.ts', line: 1 }).depHashes).sort()).toEqual(['pkg/index.js', 'y.ts']);
  });

  test('a cycle terminates and still excludes the cited file', () => {
    const r = makeRepo({ 'a.js': "require('./b');\n", 'b.js': "require('./a');\n" });
    expect(Object.keys(one(r, r.head, { file: 'a.js', line: 1 }).depHashes)).toEqual(['b.js']);
  });

  test('a documentation/data file has depHashes {} and its prose is not scanned for imports', () => {
    const out = one(repo, repo.head, { file: 'docs/readme.md', line: 2 });
    expect(out.depHashes).toEqual({});
    expect(out.hashError).toBeUndefined();
  });

  test.each([
    ['a computed specifier in the cited file', { 'a.js': "require(pick());\n" }, 'a.js', /computed/],
    ['a computed specifier in a closure member', { 'a.js': "require('./b');\n", 'b.js': 'require(`./x/${n}`);\n' }, 'a.js', /computed/],
    ['an unanalyzable source type', { 'tool.py': 'import os\n' }, 'tool.py', /cannot be analyzed/],
  ])('%s => hashError and no hash fields', (_name, files, file, pattern) => {
    const r = makeRepo(files);
    const out = one(r, r.head, { file, line: 1 });
    expect(out.hashError).toMatch(pattern);
    expect(out).not.toHaveProperty('hunkHash');
    expect(out).not.toHaveProperty('depHashes');
  });

  test('an unresolved relative specifier (cited file or closure member) is hashed as an ABSENT dependency, not a failure', () => {
    const absent = require('crypto').createHash('sha256').update('absent').digest('hex');
    const r = makeRepo({ 'src/a.js': "require('./gone');\nrequire('./b');\n", 'src/b.js': "// see ../docs/missing in prose\nrequire('./gone2');\n" });
    const out = one(r, r.head, { file: 'src/a.js', line: 1 });
    expect(out.hashError).toBeUndefined();
    expect(out.hunkHash).toMatch(SHA);
    expect(out.depHashes['src/gone']).toBe(absent);
    expect(out.depHashes['src/gone2']).toBe(absent);
    expect(out.depHashes['src/b.js']).toMatch(SHA);
    expect(Object.keys(out.depHashes)).toHaveLength(3);
  });

  test('a specifier climbing above the repository root is ignored', () => {
    const r = makeRepo({ 'a.js': "require('../../outside');\n" });
    const out = one(r, r.head, { file: 'a.js', line: 1 });
    expect(out.hashError).toBeUndefined();
    expect(out.depHashes).toEqual({});
  });

  test('absent entries do not count toward the 200-file cap', () => {
    const files = { 'entry.js': Array.from({ length: 250 }, (_, i) => `require('./nope/${i}');`).join('\n') + '\n' };
    const r = makeRepo(files);
    const out = one(r, r.head, { file: 'entry.js', line: 1 });
    expect(out.hashError).toBeUndefined();
    expect(Object.keys(out.depHashes)).toHaveLength(250);
  });

  test('a closure of 200 files hashes, 201 fails closed', () => {
    const build = (n) => {
      const files = { 'entry.js': Array.from({ length: n }, (_, i) => `require('./m/${i}');`).join('\n') + '\n' };
      for (let i = 0; i < n; i += 1) files[`m/${i}.js`] = `module.exports = ${i};\n`;
      return makeRepo(files);
    };
    const ok = build(200);
    const okOut = one(ok, ok.head, { file: 'entry.js', line: 1 });
    expect(Object.keys(okOut.depHashes)).toHaveLength(200);
    const over = build(201);
    const overOut = one(over, over.head, { file: 'entry.js', line: 1 });
    expect(overOut.hashError).toMatch(/exceeds 200/);
    expect(overOut).not.toHaveProperty('depHashes');
    expect(overOut).not.toHaveProperty('hunkHash');
  });

  test('one bad citation does not poison the others, and git is called a bounded number of times', () => {
    const calls = [];
    const real = require('../lib/review-prepare-runtime').defaultDeps().git;
    const out = hashCitations({
      repoRoot: repo.root,
      headSha: repo.head,
      citations: [
        { id: 'ok', file: 'src/a.js', line: 5 },
        { id: 'same', file: 'src/a.js', line: 6 },
        { id: 'bad', file: 'src/missing.js', line: 1 },
      ],
    }, { git: (args, opts) => { calls.push(args[0]); return real(args, opts); } });
    expect(out.candidates.map((c) => ('hashError' in c ? 'err' : 'ok'))).toEqual(['ok', 'ok', 'err']);
    // ls-tree once; cat-file per level (cited blob(s), then b/c.json, then d): the second citation hits the cache.
    expect(calls.filter((c) => c === 'ls-tree')).toHaveLength(1);
    expect(calls.filter((c) => c === 'cat-file').length).toBeLessThanOrEqual(5);
  });
});

describe('request validation and the CLI', () => {
  const repo = makeRepo({ 'a.js': 'x\n' });

  test('hashCitations refuses unknown keys, a short headSha and malformed citations', () => {
    expect(hashCitations({ headSha: repo.head, citations: [], extra: 1 }).ok).toBe(false);
    expect(hashCitations({ headSha: 'abc123', citations: [] }).ok).toBe(false);
    expect(hashCitations({ headSha: repo.head, citations: [{ file: 'a.js', line: 1, severity: 'High' }] }).ok).toBe(false);
    expect(hashCitations({ headSha: repo.head, citations: 'a.js' }).ok).toBe(false);
  });

  test('an unreadable head is a request error, not a hash', () => {
    const out = hashCitations({ repoRoot: repo.root, headSha: '0'.repeat(40), citations: [{ file: 'a.js', line: 1 }] });
    expect(out.ok).toBe(false);
  });

  test('CLI: exit 0 with hashes; unknown key and bad JSON exit 1', () => {
    const emitted = [];
    const emit = (v) => emitted.push(v);
    expect(main({ readJson: () => ({ repoRoot: repo.root, headSha: repo.head, citations: [{ file: 'a.js', line: 1 }] }), emit })).toBe(0);
    expect(emitted[0].candidates[0].hunkHash).toMatch(SHA);
    expect(main({ readJson: () => ({ headSha: repo.head, citations: [], bogus: true }), emit })).toBe(1);
    expect(emitted[1]).toMatchObject({ ok: false });
    expect(main({ readJson: () => { throw new Error('Unexpected token'); }, emit })).toBe(1);
    expect(emitted[2].error).toMatch(/invalid JSON/);
  });

  test('CLI: default output goes through redact', () => {
    const secret = `ghp_${'a'.repeat(30)}`;
    const writes = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    try {
      main({ readJson: () => ({ repoRoot: repo.root, headSha: repo.head, citations: [{ file: 'a.js', line: 1, claim: `leaks ${secret}` }] }) });
    } finally {
      spy.mockRestore();
    }
    const printed = writes.join('');
    expect(printed).not.toContain(secret);
    expect(printed).toContain('[REDACTED]');
    expect(printed.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(printed).ok).toBe(true);
  });
});

describe('contract with planCarry', () => {
  test('untouched citation carries; a citation whose dependency changed in the delta is reverify dependency-changed', () => {
    const repo = makeRepo({
      'src/a.js': "require('./dep');\n" + lines(10),
      'src/dep.js': 'module.exports = 1;\n',
      'src/b.js': "require('./other');\n" + lines(10),
      'src/other.js': 'module.exports = 1;\n',
    });
    const h1 = repo.head;
    const citations = [
      { id: 'A', file: 'src/a.js', line: 5, claim: 'a is wrong' },
      { id: 'B', file: 'src/b.js', line: 5, claim: 'b is wrong' },
    ];
    const at = (sha) => hashCitations({ repoRoot: repo.root, headSha: sha, citations }).candidates;
    const priorVerdicts = at(h1).map((c) => ({ ...c, head: h1, outcome: 'present', votes: [{ verifier: 'v1', verdict: 'confirmed' }] }));
    const h2 = repo.commit({ 'src/dep.js': 'module.exports = 2;\n', 'src/unrelated.md': 'note\n' });
    const deltaPaths = git(repo.root, ['diff', '--name-only', h1, h2]).split('\n');
    expect(deltaPaths.sort()).toEqual(['src/dep.js', 'src/unrelated.md']);
    const plan = planCarry({
      headSha: h2, lastReviewedSha: h1, deltaPlan: { mode: 'delta' }, deltaPaths, highPaths: [], priorVerdicts, candidates: at(h2),
    });
    expect(plan.ok).toBe(true);
    expect(plan.carried.map((c) => c.id)).toEqual(['B']);
    expect(plan.carried[0]).toMatchObject({ head: h2, carriedFrom: h1 });
    expect(plan.reverify).toHaveLength(1);
    expect(plan.reverify[0]).toMatchObject({ id: 'A' });
    expect(plan.reverify[0].reasons).toContain(REASONS.DEPENDENCY_CHANGED);
  });

  test('a delta that ADDS the file a dangling import named makes the verdict dependency-changed', () => {
    const repo = makeRepo({ 'src/a.js': "require('./gone');\n" + lines(10), 'src/b.js': lines(10) });
    const h1 = repo.head;
    const citations = [{ id: 'A', file: 'src/a.js', line: 5, claim: 'a is wrong' }, { id: 'B', file: 'src/b.js', line: 5, claim: 'b is wrong' }];
    const at = (sha) => hashCitations({ repoRoot: repo.root, headSha: sha, citations }).candidates;
    const priorVerdicts = at(h1).map((c) => ({ ...c, head: h1, outcome: 'present', votes: [{ verifier: 'v1', verdict: 'confirmed' }] }));
    const h2 = repo.commit({ 'src/gone.js': 'module.exports = 1;\n' });
    const deltaPaths = git(repo.root, ['diff', '--name-only', h1, h2]).split('\n');
    const plan = planCarry({
      headSha: h2, lastReviewedSha: h1, deltaPlan: { mode: 'delta' }, deltaPaths, highPaths: [], priorVerdicts, candidates: at(h2),
    });
    expect(plan.carried.map((c) => c.id)).toEqual(['B']);
    expect(plan.reverify).toHaveLength(1);
    expect(plan.reverify[0]).toMatchObject({ id: 'A' });
    expect(plan.reverify[0].reasons).toContain(REASONS.DEPENDENCY_CHANGED);
  });

  test('a citation that could not be hashed at the new head is re-verified (hash-missing), never carried', () => {
    const repo = makeRepo({ 'src/a.js': lines(10) });
    const h1 = repo.head;
    const citation = { id: 'A', file: 'src/a.js', line: 5, claim: 'a is wrong' };
    const prior = hashCitations({ repoRoot: repo.root, headSha: h1, citations: [citation] }).candidates[0];
    const h2 = repo.commit({ 'src/a.js': "require(pick());\n" + lines(10) });
    const candidate = hashCitations({ repoRoot: repo.root, headSha: h2, citations: [citation] }).candidates[0];
    expect(candidate.hashError).toBeDefined();
    const plan = planCarry({
      headSha: h2,
      lastReviewedSha: h1,
      deltaPlan: { mode: 'delta' },
      deltaPaths: ['unrelated.md'],
      highPaths: [],
      priorVerdicts: [{ ...prior, head: h1, outcome: 'present', votes: [{ verifier: 'v1', verdict: 'confirmed' }] }],
      candidates: [candidate],
    });
    expect(plan.carried).toEqual([]);
    expect(plan.reverify[0].reasons).toContain(REASONS.HASH_MISSING);
  });
});
