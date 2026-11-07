'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { main, deriveCleared } = require('../lib/pr-review-clear-cli');
const { defaultGit } = require('../lib/review-record-runtime');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-clear-cli.js');
const roots = [];

function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir, files, message, remove = []) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  for (const name of remove) fs.unlinkSync(path.join(dir, name));
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', message]);
  return sh(dir, ['rev-parse', 'HEAD']);
}

const numbered = (n, replace = {}) => Array.from({ length: n }, (_, i) => replace[i + 1] || `line ${i + 1}`).join('\n') + '\n';

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

const finding = (id, locationOrLink, failureMode, extra = {}) => ({
  id,
  source: 'reviewer',
  locationOrLink,
  severity: 'important',
  failureMode,
  disposition: 'fix',
  evidence: `evidence ${id}`,
  originalTextOrLink: `https://example.test/${id}`,
  ...extra
});

let dir;
let base;
let p1;
let p2;
let p3;
let old;
let unrelated;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prr-clear-')));
  roots.push(dir);
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'T']);
  sh(dir, ['config', 'user.email', 't@example.com']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  base = commit(dir, { 'README.md': 'base\n' }, 'base');
  p1 = commit(dir, { 'src/widget.js': numbered(30), 'src/other.js': numbered(5), 'src/doomed.js': numbered(4) }, 'p1');
  // The PR head after a "fix": line 12 edited, two lines inserted above it, a file deleted.
  const edited = numbered(30, { 12: 'CHANGED 12' }).replace('line 2\n', 'line 2\nins a\nins b\n');
  p2 = commit(dir, { 'src/widget.js': edited }, 'p2', ['src/doomed.js']);
  // A history that replaced P1 (force-push): not an ancestor of p2.
  sh(dir, ['checkout', '-q', '-b', 'old', p1]);
  old = commit(dir, { 'src/widget.js': numbered(30, { 12: 'OTHER' }) }, 'old');
  sh(dir, ['checkout', '-q', '--orphan', 'unrelated']);
  sh(dir, ['rm', '-rf', '-q', '.']);
  unrelated = commit(dir, { 'z.txt': 'z\n' }, 'unrelated');
  sh(dir, ['checkout', '-q', 'main']);
  // A later PR head that edits another file only: the finding's own file is untouched between p2 and p3.
  p3 = commit(dir, { 'src/other.js': numbered(5, { 3: 'CHANGED OTHER 3' }) }, 'p3');
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const derive = (ledger, extra = {}) =>
  deriveCleared({ git: defaultGit(), cwd: dir, baseSha: base, headSha: p2, ledger, incoming: [], now: () => 0, ...extra });

const reasonOf = (result, id) => result.kept.find((k) => k.id === id).reason;

describe('deriveCleared rules', () => {
  test('1 already cleared is unchanged', () => {
    const e = finding('a', 'src/widget.js:12', 'bad', { headSha: p1, cleared: true, clearedBy: 'f'.repeat(40) });
    const r = derive([e]);
    expect(r.kept).toEqual([{ id: 'a', reason: 'already-cleared' }]);
    expect(r.ledger).toEqual([e]);
  });

  test('2 no readable recorded head is kept', () => {
    const r = derive([
      finding('none', 'src/widget.js:12', 'bad'),
      finding('junk', 'src/widget.js:12', 'bad', { headSha: 'main' }),
      finding('gone', 'src/widget.js:12', 'bad', { headSha: 'deadbeefdeadbeef' }),
      finding('num', 'src/widget.js:12', 'bad', { headSha: 7 })
    ]);
    expect(r.kept.map((k) => k.reason)).toEqual(['no-recorded-head', 'no-recorded-head', 'no-recorded-head', 'no-recorded-head']);
    expect(r.cleared).toEqual([]);
  });

  test('3 recorded at this very head is kept, also by abbreviation', () => {
    const r = derive([finding('a', 'src/widget.js:12', 'bad', { headSha: p2 }), finding('b', 'src/widget.js:12', 'bad', { headSha: p2.slice(0, 10) })]);
    expect(r.kept.map((k) => k.reason)).toEqual(['recorded-at-this-head', 'recorded-at-this-head']);
  });

  test('4 a head in base history, a force-pushed old head and an unrelated head are kept', () => {
    const r = derive([
      finding('base', 'src/widget.js:12', 'bad', { headSha: base }),
      finding('old', 'src/widget.js:12', 'bad', { headSha: old }),
      finding('unrel', 'src/widget.js:12', 'bad', { headSha: unrelated })
    ]);
    expect(r.kept.map((k) => k.reason)).toEqual(['recorded-head-not-on-pr', 'recorded-head-not-on-pr', 'recorded-head-not-on-pr']);
    expect(r.cleared).toEqual([]);
  });

  test('5 a defect re-reported two lines lower after the shift is re-reported, not cleared', () => {
    const e = finding('shift', 'src/widget.js:12', 'Off by one in loop', { headSha: p1 });
    const r = derive([e], { incoming: [finding('new', 'src/widget.js:14', 'off by one in loop!')] });
    expect(r.kept).toEqual([{ id: 'shift', reason: 're-reported' }]);
    expect(r.cleared).toEqual([]);
    expect(r.ledger[0]).toEqual(e);
  });

  test('5 without a fingerprint the same location and failure mode counts', () => {
    const a = finding('a', 'https://example.test/pr/1#c', 'same words', { headSha: p1 });
    const r = derive([a], { incoming: [{ ...a, id: 'b' }] });
    expect(r.kept).toEqual([{ id: 'a', reason: 're-reported' }]);
  });

  test('5 a different failure mode at the same place is not a re-report', () => {
    const e = finding('a', 'src/widget.js:12', 'Off by one', { headSha: p1 });
    const r = derive([e], { incoming: [finding('n', 'src/widget.js:12', 'Null dereference')] });
    expect(r.cleared.map((c) => c.id)).toEqual(['a']);
  });

  test('6 a finding citing no file is kept', () => {
    const r = derive([finding('link', 'https://example.test/pr/1#c', 'bad', { headSha: p1 })]);
    expect(r.kept).toEqual([{ id: 'link', reason: 'no-location' }]);
  });

  test('7 an untouched location is kept; a diff git cannot produce is diff-failed', () => {
    const untouched = finding('u', 'src/other.js:3', 'bad', { headSha: p1 });
    const lineOnly = finding('l', 'src/widget.js:20', 'bad', { headSha: p1 });
    const r = derive([untouched, lineOnly]);
    expect(r.kept).toEqual([
      { id: 'u', reason: 'location-unchanged' },
      { id: 'l', reason: 'location-unchanged' }
    ]);

    const real = defaultGit();
    const failing = (args, opts) => (args.includes('diff') ? { status: 128, stdout: '', stderr: 'boom' } : real(args, opts));
    const f = derive([finding('d', 'src/widget.js:12', 'bad', { headSha: p1 })], { git: failing });
    expect(f.kept).toEqual([{ id: 'd', reason: 'diff-failed' }]);
  });

  test('8 an edited line clears with the full head id and the ledger mark shape', () => {
    const e = finding('hit', 'src/widget.js:12', 'bad', { headSha: p1.slice(0, 12), custom: { keep: 1 } });
    const r = derive([e]);
    expect(r.cleared).toEqual([{ id: 'hit', clearedBy: p2, recordedAt: '1970-01-01T00:00:00.000Z' }]);
    expect(r.kept).toEqual([]);
    expect(r.ledger[0]).toEqual({ ...e, cleared: true, clearedBy: p2, clearedReason: 'location-changed' });
    expect(r.headSha).toBe(p2);
  });

  test('8 a finding in a deleted file and a file-only citation clear; an unchanged file-only one is kept', () => {
    const r = derive([
      finding('del', 'src/doomed.js:2', 'bad', { headSha: p1 }),
      finding('fileonly', 'src/widget.js', 'bad', { headSha: p1 }),
      finding('same', 'src/other.js', 'bad', { headSha: p1 })
    ]);
    expect(r.cleared.map((c) => c.id)).toEqual(['del', 'fileonly']);
    expect(r.kept).toEqual([{ id: 'same', reason: 'location-unchanged' }]);
  });

  test('a changed line OTHER than the cited one does not clear a line-anchored finding', () => {
    const r = derive([finding('x', 'src/widget.js:13', 'bad', { headSha: p1 })]);
    expect(r.kept).toEqual([{ id: 'x', reason: 'location-unchanged' }]);
  });
});

describe('deriveCleared whole-ledger properties', () => {
  const ledger = () => [
    finding('hit', 'src/widget.js:12', 'bad', { headSha: p1 }),
    finding('keep', 'src/other.js:3', 'bad', { headSha: p1 }),
    finding('nohead', 'src/widget.js:12', 'bad'),
    finding('basehist', 'src/widget.js:12', 'bad', { headSha: base, odd: ' spaced ' }),
    finding('del', 'src/doomed.js:2', 'bad', { headSha: p1 })
  ];

  test('same length and order; kept entries are returned as given', () => {
    const input = ledger();
    const r = derive(input);
    expect(r.ledger.map((e) => e.id)).toEqual(['hit', 'keep', 'nohead', 'basehist', 'del']);
    expect(r.cleared.map((c) => c.id)).toEqual(['hit', 'del']);
    expect(r.ledger[1]).toEqual(input[1]);
    expect(r.ledger[3]).toEqual(input[3]);
    expect(r.ledger[0].cleared).toBe(true);
    expect(r.ledger[1].cleared).toBeUndefined();
  });

  test('idempotent: a second run over its own output changes nothing', () => {
    const first = derive(ledger());
    const second = derive(first.ledger);
    expect(second.ledger).toEqual(first.ledger);
    expect(second.cleared).toEqual([]);
    expect(reasonOf(second, 'hit')).toBe('already-cleared');
  });

  test('never mutates a deep-frozen input', () => {
    const input = deepFreeze(ledger());
    const incoming = deepFreeze([finding('n', 'src/other.js:1', 'x')]);
    expect(() => derive(input, { incoming })).not.toThrow();
  });

  test('failures: head or base not a commit, head not descending from base', () => {
    expect(derive([], { headSha: 'a'.repeat(40) })).toEqual({ ok: false, status: 'FAILED', reason: 'headSha is not a commit of this repository' });
    expect(derive([], { baseSha: 'a'.repeat(40) })).toEqual({ ok: false, status: 'FAILED', reason: 'baseSha is not a commit of this repository' });
    expect(derive([], { headSha: unrelated }).reason).toBe('headSha does not descend from baseSha');
    expect(derive([], { baseSha: p2, headSha: p1 }).reason).toBe('headSha does not descend from baseSha');
  });

  test('never writes: HEAD, refs, status and the index are identical after a run', () => {
    const snap = () => ({
      head: sh(dir, ['rev-parse', 'HEAD']),
      refs: sh(dir, ['for-each-ref']),
      status: sh(dir, ['status', '--porcelain']),
      index: fs.readFileSync(path.join(dir, '.git', 'index')).toString('hex')
    });
    const before = snap();
    derive(ledger());
    expect(snap()).toEqual(before);
  });
});

describe('main', () => {
  const run = (payload, io = {}) => {
    const out = [];
    const code = main({ readJson: () => payload, emit: (v) => out.push(v), now: () => 5, ...io });
    return { code, result: out[0] };
  };
  const good = () => ({ repoRoot: dir, baseSha: base, headSha: p2, ledger: [finding('hit', 'src/widget.js:12', 'bad', { headSha: p1 })] });
  const noHead = () => ({ ...good(), ledger: [finding('hit', 'src/widget.js:12', 'bad')] });

  test('exit 0 with a DERIVED result and wallMs', () => {
    const { code, result } = run(good());
    expect(code).toBe(0);
    expect(result).toMatchObject({ ok: true, status: 'DERIVED', headSha: p2, wallMs: 0 });
    expect(result.cleared.map((c) => c.id)).toEqual(['hit']);
  });

  test('incoming defaults to [] and is used when given', () => {
    const payload = { ...good(), incoming: [finding('n', 'src/widget.js:14', 'bad')] };
    expect(run(payload).result.kept).toEqual([{ id: 'hit', reason: 're-reported' }]);
  });

  test('lastReviewedSha is the baseline of an entry that carries no head, and is optional', () => {
    expect(run(noHead()).result.kept).toEqual([{ id: 'hit', reason: 'no-recorded-head' }]);
    const { code, result } = run({ ...noHead(), lastReviewedSha: p1 });
    expect(code).toBe(0);
    expect(result.cleared.map((c) => c.id)).toEqual(['hit']);
  });

  test('exit 1 FAILED for bad input, in validation order, with nothing partial', () => {
    const cases = [
      [null, /JSON object/],
      [[], /JSON object/],
      [{ ...good(), repoRoot: undefined }, /repoRoot/],
      [{ ...good(), repoRoot: '  ' }, /repoRoot/],
      [{ ...good(), baseSha: 'abc' }, /baseSha/],
      [{ ...good(), headSha: 'abc' }, /headSha/],
      [{ ...good(), ledger: {} }, /ledger/],
      [{ ...good(), ledger: [1] }, /ledger/],
      [{ ...good(), incoming: 'x' }, /incoming/],
      [{ ...good(), lastReviewedSha: 'abc' }, /lastReviewedSha/],
      [{ ...good(), lastReviewedSha: null }, /lastReviewedSha/],
      [{ ...good(), repoRoot: path.join(dir, 'src') }, /not a git repository root/],
      [{ ...good(), headSha: 'a'.repeat(40) }, /not a commit/],
      [{ ...good(), headSha: unrelated }, /does not descend/]
    ];
    for (const [payload, pattern] of cases) {
      const { code, result } = run(payload);
      expect(code).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.reason).toMatch(pattern);
      expect(result.ledger).toBeUndefined();
    }
  });

  test('invalid JSON is a failure', () => {
    const out = [];
    const code = main({
      readJson: () => {
        throw new Error('nope');
      },
      emit: (v) => out.push(v)
    });
    expect(code).toBe(1);
    expect(out[0].reason).toMatch(/invalid JSON/);
  });

  test('uses an injected git', () => {
    const calls = [];
    const git = (args) => {
      calls.push(args);
      return { status: 128, stdout: '', stderr: '' };
    };
    const { code, result } = run(good(), { git });
    expect(code).toBe(1);
    expect(result.reason).toMatch(/not a commit/);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('lastReviewedSha: the one baseline every carried entry shares', () => {
  test('an entry with no head of its own is compared from lastReviewedSha; without it that entry is kept', () => {
    const e = finding('a', 'src/widget.js:12', 'bad');
    const r = derive([e], { lastReviewedSha: p1 });
    expect(r.cleared).toEqual([{ id: 'a', clearedBy: p2, recordedAt: '1970-01-01T00:00:00.000Z' }]);
    expect(r.ledger[0]).toEqual({ ...e, cleared: true, clearedBy: p2, clearedReason: 'location-changed' });
    expect(derive([e]).kept).toEqual([{ id: 'a', reason: 'no-recorded-head' }]);
  });

  test('an edit the finding SURVIVED is not counted: it was alive at lastReviewedSha, so only what changed since can have fixed it', () => {
    // Raised at p1. p2 edited its line and the review of p2 raised it again, so it carried on. p3 touches another file only.
    const survivor = finding('survivor', 'src/widget.js:12', 'Off by one', { headSha: p1 });
    // From its own head the edit p2 made would count, so a delta review of p3 that cannot see line 12 would clear it.
    expect(derive([survivor], { headSha: p3 }).cleared.map((c) => c.id)).toEqual(['survivor']);
    const r = derive([survivor], { headSha: p3, lastReviewedSha: p2 });
    expect(r.cleared).toEqual([]);
    expect(r.kept).toEqual([{ id: 'survivor', reason: 'location-unchanged' }]);
    expect(r.ledger[0]).toEqual(survivor);
  });

  test('an edit made since lastReviewedSha clears, whatever head the entry carries', () => {
    const r = derive([finding('a', 'src/other.js:3', 'bad', { headSha: p1 })], { headSha: p3, lastReviewedSha: p2 });
    expect(r.cleared).toEqual([{ id: 'a', clearedBy: p3, recordedAt: '1970-01-01T00:00:00.000Z' }]);
  });

  test('lastReviewedSha equal to the head is the same head reviewed again: nothing clears', () => {
    const r = derive([finding('a', 'src/widget.js:12', 'bad')], { lastReviewedSha: p2 });
    expect(r.kept).toEqual([{ id: 'a', reason: 'recorded-at-this-head' }]);
    expect(r.cleared).toEqual([]);
  });

  test('a lastReviewedSha that is not on the PR keeps every entry, though its own head is', () => {
    const entries = [finding('a', 'src/widget.js:12', 'bad', { headSha: p1 }), finding('b', 'src/widget.js:12', 'bad')];
    for (const lastReviewedSha of [old, base, unrelated, 'a'.repeat(40)]) {
      const r = derive(entries, { lastReviewedSha });
      expect(r.kept).toEqual([
        { id: 'a', reason: 'recorded-head-not-on-pr' },
        { id: 'b', reason: 'recorded-head-not-on-pr' }
      ]);
      expect(r.cleared).toEqual([]);
    }
  });

  test('an entry stamped with this very head is never cleared by it', () => {
    const r = derive([finding('a', 'src/widget.js:12', 'bad', { headSha: p2 })], { lastReviewedSha: p1 });
    expect(r.kept).toEqual([{ id: 'a', reason: 'recorded-at-this-head' }]);
  });

  test('a re-report still keeps the entry', () => {
    const e = finding('a', 'src/widget.js:12', 'Off by one');
    const r = derive([e], { lastReviewedSha: p1, incoming: [finding('n', 'src/widget.js:14', 'off by one')] });
    expect(r.kept).toEqual([{ id: 'a', reason: 're-reported' }]);
    expect(r.ledger[0]).toEqual(e);
  });
});

describe('entry point', () => {
  test('reads the payload on stdin and prints one JSON result', () => {
    const payload = { repoRoot: dir, baseSha: base, headSha: p2, ledger: [finding('hit', 'src/widget.js:12', 'bad', { headSha: p1 })] };
    const r = spawnSync('node', [CLI], { input: JSON.stringify(payload), encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe('DERIVED');
    expect(out.ledger[0]).toMatchObject({ id: 'hit', cleared: true, clearedBy: p2, clearedReason: 'location-changed' });
    expect(out.cleared[0]).toMatchObject({ id: 'hit', clearedBy: p2 });
  });

  test('a failure exits 1', () => {
    const r = spawnSync('node', [CLI], { input: '{}', encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe('FAILED');
  });
});
