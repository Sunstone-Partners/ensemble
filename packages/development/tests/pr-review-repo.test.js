'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const repo = require('../lib/pr-review-repo');
const runtime = require('../lib/review-record-runtime');

const roots = [];

function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function mkdir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function initRepo(dir) {
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'T']);
  sh(dir, ['config', 'user.email', 't@example.com']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
}

function commit(dir, files, message) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', message]);
  return sh(dir, ['rev-parse', 'HEAD']);
}

const numbered = (n, replace = {}) =>
  Array.from({ length: n }, (_, i) => replace[i + 1] || `line ${i + 1}`).join('\n') + '\n';

const git = runtime.defaultGit();
let dir;
let base;
let p1;
let p2;
let other;

beforeAll(() => {
  dir = mkdir('prr-repo-');
  initRepo(dir);
  base = commit(dir, { 'README.md': 'base\n' }, 'base');
  p1 = commit(dir, { 'src/widget.js': numbered(30), 'src/other.js': numbered(5), 'bin.dat': Buffer.from([0, 1, 2, 3]) }, 'p1');
  p2 = commit(dir, { 'src/widget.js': numbered(30, { 12: 'CHANGED 12' }) }, 'p2');
  sh(dir, ['checkout', '-q', '--orphan', 'unrelated']);
  sh(dir, ['rm', '-rf', '-q', '.']);
  other = commit(dir, { 'z.txt': 'z\n' }, 'unrelated');
  sh(dir, ['checkout', '-q', 'main']);
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const scripted = (reply) => {
  const calls = [];
  const fake = (args, opts) => {
    calls.push({ args, opts });
    return reply(args);
  };
  fake.calls = calls;
  return fake;
};

describe('resolveCommit', () => {
  test('resolves an abbreviation to the full lowercase id', () => {
    expect(repo.resolveCommit(git, dir, p2.slice(0, 8))).toBe(p2);
    expect(repo.resolveCommit(git, dir, p2.toUpperCase())).toBe(p2);
  });

  test('an unknown hex id is null', () => {
    expect(repo.resolveCommit(git, dir, 'deadbeefdeadbeef')).toBeNull();
  });

  test('anything that is not 7-64 hex never reaches git', () => {
    const fake = scripted(() => ({ status: 0, stdout: `${p2}\n`, stderr: '' }));
    for (const bad of ['main', 'HEAD', '--output=x', '-h', 'abc123', 'g'.repeat(10), `${'a'.repeat(65)}`, '', null, undefined, 42, {}]) {
      expect(repo.resolveCommit(fake, dir, bad)).toBeNull();
    }
    expect(fake.calls).toHaveLength(0);
  });

  test('asks git for the commit peel of a verified, quiet rev', () => {
    const fake = scripted(() => ({ status: 1, stdout: '', stderr: '' }));
    expect(repo.resolveCommit(fake, '/x', 'abcdef1')).toBeNull();
    expect(fake.calls[0]).toEqual({ args: ['rev-parse', '--verify', '--quiet', 'abcdef1^{commit}'], opts: { cwd: '/x' } });
  });

  test('a git that could not be spawned is null', () => {
    expect(repo.resolveCommit(() => ({ status: 127, stdout: '', stderr: 'ENOENT' }), dir, p2)).toBeNull();
  });
});

describe('isAncestor', () => {
  test('true, false, and null for anything else', () => {
    expect(repo.isAncestor(git, dir, p1, p2)).toBe(true);
    expect(repo.isAncestor(git, dir, p2, p1)).toBe(false);
    expect(repo.isAncestor(git, dir, p2, p2)).toBe(true);
    expect(repo.isAncestor(() => ({ status: 128, stdout: '', stderr: '' }), dir, p1, p2)).toBeNull();
  });

  test('a non-hex argument is null without a git call', () => {
    const fake = scripted(() => ({ status: 0, stdout: '', stderr: '' }));
    expect(repo.isAncestor(fake, dir, '--foo', p2)).toBeNull();
    expect(repo.isAncestor(fake, dir, p1, 'main')).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('commitOnPr', () => {
  const on = (commitId, head = p2, baseSha = base) => repo.commitOnPr(git, dir, { commit: commitId, headSha: head, baseSha });

  test('accepts a PR commit, the head itself, and an abbreviation', () => {
    expect(on(p1)).toEqual({ ok: true, commit: p1 });
    expect(on(p2)).toEqual({ ok: true, commit: p2 });
    expect(on(p1.slice(0, 9))).toEqual({ ok: true, commit: p1 });
  });

  test('rejects base history, including the base itself', () => {
    expect(on(base)).toEqual({ ok: false, reason: 'in-base-history' });
  });

  test('rejects a commit on an unrelated branch', () => {
    expect(on(other)).toEqual({ ok: false, reason: 'not-an-ancestor-of-head' });
  });

  test('distinct reasons for an unknown commit, a missing head and a missing base', () => {
    expect(on('deadbeefdeadbeef')).toEqual({ ok: false, reason: 'commit-not-found' });
    expect(on('main')).toEqual({ ok: false, reason: 'commit-not-found' });
    expect(on(p1, 'deadbeefdeadbeef')).toEqual({ ok: false, reason: 'head-not-found' });
    expect(on(p1, p2, 'deadbeefdeadbeef')).toEqual({ ok: false, reason: 'base-not-found' });
  });

  test('a null ancestry answer fails closed as ancestry-unknown', () => {
    const fake = scripted((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: `${p1}\n`, stderr: '' } : { status: 128, stdout: '', stderr: 'boom' }
    );
    expect(repo.commitOnPr(fake, dir, { commit: p1, headSha: p2, baseSha: base })).toEqual({ ok: false, reason: 'ancestry-unknown' });
  });

  test('an unknown ancestry against the base fails closed too', () => {
    const fake = scripted((args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${p1}\n`, stderr: '' };
      return args[3] === base || args[4] === base ? { status: 128, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' };
    });
    const result = repo.commitOnPr(fake, dir, { commit: p1, headSha: p1, baseSha: base });
    expect(result.ok).toBe(false);
    expect(['ancestry-unknown', 'in-base-history']).toContain(result.reason);
  });
});

describe('primaryWorktree', () => {
  test('returns the primary from the primary and from a linked worktree', () => {
    expect(repo.primaryWorktree(git, dir)).toEqual({ ok: true, path: dir });
    const linked = path.join(mkdir('prr-linked-'), 'wt');
    sh(dir, ['worktree', 'add', '-q', '--detach', linked, p1]);
    expect(repo.primaryWorktree(git, linked)).toEqual({ ok: true, path: dir });
    sh(dir, ['worktree', 'remove', '--force', linked]);
  });

  test('a bare repository common dir fails', () => {
    const bare = mkdir('prr-bare-');
    sh(bare, ['init', '-q', '--bare']);
    expect(repo.primaryWorktree(git, bare)).toEqual({ ok: false, reason: 'no-primary-worktree' });
  });

  test('git failing fails', () => {
    expect(repo.primaryWorktree(() => ({ status: 128, stdout: '', stderr: '' }), dir)).toEqual({ ok: false, reason: 'no-primary-worktree' });
  });
});

describe('holdsHead', () => {
  test('true on the head and when HEAD is a descendant; false on the base and for a sha not in the repository', () => {
    expect(repo.holdsHead(git, dir, p2)).toBe(true);
    expect(repo.holdsHead(git, dir, p1)).toBe(true);
    const wt = path.join(mkdir('prr-hold-'), 'wt');
    sh(dir, ['worktree', 'add', '-q', '--detach', wt, p1]);
    expect(repo.holdsHead(git, wt, p1)).toBe(true);
    expect(repo.holdsHead(git, wt, p2)).toBe(false);
    expect(repo.holdsHead(git, wt, base)).toBe(true);
    sh(dir, ['worktree', 'remove', '--force', wt]);
    expect(repo.holdsHead(git, dir, 'deadbeefdeadbeef')).toBe(false);
  });

  test('other git failures are null', () => {
    const fake = scripted((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: `${p1}\n`, stderr: '' } : { status: 128, stdout: '', stderr: '' }
    );
    expect(repo.holdsHead(fake, dir, p1)).toBeNull();
  });
});

describe('readBlobAt', () => {
  test('reads committed text, not the working tree', () => {
    fs.writeFileSync(path.join(dir, 'src/other.js'), 'dirty\n');
    expect(repo.readBlobAt(git, dir, p1, 'src/other.js')).toEqual({ ok: true, text: numbered(5) });
    sh(dir, ['checkout', '--', 'src/other.js']);
  });

  test('text is null for a path absent at that commit', () => {
    expect(repo.readBlobAt(git, dir, base, 'src/widget.js')).toEqual({ ok: true, text: null });
  });

  test('rejects bad paths and unknown commits', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\0b', '', 'src/..']) {
      expect(repo.readBlobAt(git, dir, p1, bad)).toEqual({ ok: false, reason: 'bad-path' });
    }
    expect(repo.readBlobAt(git, dir, 'deadbeefdeadbeef', 'README.md')).toEqual({ ok: false, reason: 'commit-not-found' });
    expect(repo.readBlobAt(git, dir, p1, 'src')).toEqual({ ok: false, reason: 'not-a-blob' });
  });
});

describe('changedOldLines', () => {
  const lines = (from, to, file) => repo.changedOldLines(git, dir, { from, to, file });

  test('a modified line gives its exact old number', () => {
    expect(lines(p1, p2, 'src/widget.js')).toEqual({ ok: true, lines: [12] });
  });

  test('an unchanged file is []', () => {
    expect(lines(p1, p2, 'src/other.js')).toEqual({ ok: true, lines: [] });
  });

  test('a pure insertion contributes no old lines; a multi-hunk edit lists each', () => {
    const w = mkdir('prr-diff-');
    initRepo(w);
    const a = commit(w, { 'f.txt': numbered(40) }, 'a');
    const ins = commit(w, { 'f.txt': numbered(40).replace('line 5\n', 'line 5\nnew\nnew2\n') }, 'ins');
    expect(repo.changedOldLines(git, w, { from: a, to: ins, file: 'f.txt' })).toEqual({ ok: true, lines: [] });
    const multi = commit(
      w,
      { 'f.txt': numbered(40).replace('line 5\n', 'line 5\nnew\nnew2\n').replace('line 10\nline 11\n', 'X\n').replace('line 30\n', 'Y\nZ\n') },
      'multi'
    );
    expect(repo.changedOldLines(git, w, { from: a, to: multi, file: 'f.txt' })).toEqual({ ok: true, lines: [10, 11, 30] });
  });

  test('deleted and created files, a binary change and a mode change are the whole file (null)', () => {
    const w = mkdir('prr-diff2-');
    initRepo(w);
    const a = commit(w, { 'gone.txt': 'x\n', 'bin.dat': Buffer.from([0, 1, 2]), 'run.sh': 'echo\n' }, 'a');
    fs.unlinkSync(path.join(w, 'gone.txt'));
    fs.writeFileSync(path.join(w, 'bin.dat'), Buffer.from([0, 9, 9, 9]));
    fs.chmodSync(path.join(w, 'run.sh'), 0o755);
    fs.writeFileSync(path.join(w, 'new.txt'), 'n\n');
    sh(w, ['add', '-A']);
    sh(w, ['commit', '-q', '-m', 'b']);
    const b = sh(w, ['rev-parse', 'HEAD']);
    for (const file of ['gone.txt', 'bin.dat', 'run.sh', 'new.txt']) {
      expect(repo.changedOldLines(git, w, { from: a, to: b, file })).toEqual({ ok: true, lines: null });
    }
  });

  test('a file named like an option stays a pathspec and writes nothing', () => {
    const w = mkdir('prr-diff3-');
    initRepo(w);
    const a = commit(w, { '--output=x': 'one\n' }, 'a');
    const b = commit(w, { '--output=x': 'two\n' }, 'b');
    const before = sh(w, ['status', '--porcelain']);
    expect(repo.changedOldLines(git, w, { from: a, to: b, file: '--output=x' })).toEqual({ ok: true, lines: [1] });
    expect(fs.existsSync(path.join(w, 'x'))).toBe(false);
    expect(sh(w, ['status', '--porcelain'])).toBe(before);
  });

  test('a glob character is literal', () => {
    const w = mkdir('prr-diff4-');
    initRepo(w);
    const a = commit(w, { 'a.js': '1\n', 'b.js': '1\n' }, 'a');
    const b = commit(w, { 'a.js': '2\n' }, 'b');
    expect(repo.changedOldLines(git, w, { from: a, to: b, file: '*.js' })).toEqual({ ok: true, lines: [] });
  });

  test('unresolvable commits and bad paths fail', () => {
    expect(lines('deadbeefdeadbeef', p2, 'src/widget.js').ok).toBe(false);
    expect(lines(p1, 'main', 'src/widget.js').ok).toBe(false);
    expect(lines(p1, p2, '../x')).toEqual({ ok: false, reason: 'bad-path' });
  });

  test('a diff that git fails on is not read as "no change"', () => {
    const fake = scripted((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: `${p1}\n`, stderr: '' } : { status: 128, stdout: '', stderr: 'bad' }
    );
    expect(repo.changedOldLines(fake, dir, { from: p1, to: p2, file: 'a' })).toEqual({ ok: false, reason: 'diff-failed' });
  });

  test('runs a read-only diff with the file after --', () => {
    const fake = scripted((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: `${p1}\n`, stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    repo.changedOldLines(fake, dir, { from: p1, to: p2, file: 'a.js' });
    const diff = fake.calls.map((c) => c.args).find((a) => a.includes('diff'));
    expect(diff.slice(-2)).toEqual(['--', 'a.js']);
    expect(diff).toEqual(expect.arrayContaining(['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']));
  });
});
