'use strict';

/**
 * kata cwd4: the quality guard (`review-eval-guard.js`) fails when an
 * Important finding the eval set expects is lost.
 *
 * Two layers:
 *   1. the decision logic, driven through injected deps (in-memory files and
 *      git) so every fail-closed path can be reached;
 *   2. the committed eval set (`docs/review-eval/cases`) and the committed
 *      reconstructed deep-review output, run through the REAL entry point:
 *      the guard passes on that output, and removing any one expected
 *      Important finding from it makes the process exit 1 naming that case.
 *
 * Each assertion fails if the guard it covers is removed: a guard that
 * ignored a missing finding, scored a Nit as a find, skipped an unreadable
 * case file, accepted a case with no pinned commit, or compared nothing with
 * the previous run would turn the matching test red.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runGuard, main, checkPin } = require('../lib/review-eval-guard');
const { validateCase, staleCases } = require('../lib/pr-review-eval');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(REPO_ROOT, 'packages', 'development', 'lib', 'review-eval-guard.js');
const SHA = 'a'.repeat(40);

const CODEOWNERS = '* @owner\n';
const RULES_HASH = 'rules-hash-1';

const evalCase = (id, overrides = {}) => ({
  id,
  change: `https://example.test/pull/1 head ${SHA}`,
  bug: `bug ${id}`,
  location: { path: `src/${id}.js`, startLine: 10, endLine: 20 },
  confirmedBy: 'owner',
  rulesFile: 'REVIEW.md',
  rulesHash: RULES_HASH,
  ...overrides,
});

const important = (id, line = 15) => ({ id: `f-${id}`, severity: 'Important', locationOrLink: `src/${id}.js:${line}` });

/** An in-memory repo: files by absolute path, a case dir, and a git that knows `commits`. */
function fakeRepo({ cases, findings, history, commits = { [SHA]: { 'src/a.js': 100, 'src/b.js': 100 } }, rulesHash = RULES_HASH }) {
  const root = '/repo';
  const files = new Map();
  for (const [name, record] of Object.entries(cases)) {
    files.set(`${root}/docs/review-eval/cases/${name}`, typeof record === 'string' ? record : JSON.stringify(record));
  }
  files.set(`${root}/.github/CODEOWNERS`, CODEOWNERS);
  files.set(`${root}/REVIEW.md`, 'rules');
  files.set('/out/findings.json', JSON.stringify({ findingsByCase: findings }));
  if (history !== undefined) files.set('/out/history.jsonl', history);
  const appended = [];
  const deps = {
    readFile: (file) => {
      if (!files.has(file)) throw new Error(`ENOENT ${file}`);
      return files.get(file);
    },
    readDir: (dir) => {
      const prefix = `${dir}/`;
      return [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
    exists: (file) => files.has(file),
    appendFile: (file, text) => {
      appended.push(text);
      files.set(file, `${files.get(file) || ''}${text}`);
    },
    now: () => '2026-11-06T00:00:00.000Z',
    git: (args) => {
      if (args[0] === 'hash-object') return { status: 0, stdout: `${rulesHash}\n`, stderr: '' };
      if (args[0] === 'cat-file') {
        const sha = args[2].replace(/\^\{commit\}$/, '');
        return { status: commits[sha] ? 0 : 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'show') {
        const [sha, file] = args[1].split(':');
        const lines = commits[sha] && commits[sha][file];
        return lines ? { status: 0, stdout: `${'x\n'.repeat(lines)}`, stderr: '' } : { status: 128, stdout: '', stderr: 'fatal' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected git call' };
    },
  };
  return { root, deps, files, appended };
}

const twoCases = () => ({
  'a.json': evalCase('a', { location: { path: 'src/a.js', startLine: 10, endLine: 20 } }),
  'b.json': evalCase('b', { location: { path: 'src/b.js', startLine: 10, endLine: 20 } }),
});
const bothFound = () => ({ a: [important('a')], b: [important('b')] });

const run = (repo, extra = {}) =>
  runGuard({ repoRoot: repo.root, findingsPath: '/out/findings.json', ...extra }, repo.deps);

describe('quality guard decision logic', () => {
  test('passes, with a zero false-negative rate, when every expected Important finding is present', () => {
    const result = run(fakeRepo({ cases: twoCases(), findings: bothFound() }));
    expect(result).toMatchObject({ pass: true, cases: 2, found: 2, missed: [], falseNegativeRate: 0, problems: [] });
  });

  test('fails and names the case when one expected Important finding is removed', () => {
    const result = run(fakeRepo({ cases: twoCases(), findings: { a: [important('a')], b: [] } }));
    expect(result.pass).toBe(false);
    expect(result.problems).toContain('important-finding-lost');
    expect(result.missed).toEqual([{ id: 'b', reason: 'no-important-finding-at-location' }]);
    expect(result.falseNegativeRate).toBe(0.5);
  });

  test('a Nit, a Pre-existing finding or an Important finding outside the range does not stand in for the lost one', () => {
    const findings = {
      a: [important('a')],
      b: [
        { id: 'n', severity: 'Nit', locationOrLink: 'src/b.js:15' },
        { id: 'p', severity: 'Pre-existing', locationOrLink: 'src/b.js:16' },
        { id: 'far', severity: 'Important', locationOrLink: 'src/b.js:99' },
      ],
    };
    const result = run(fakeRepo({ cases: twoCases(), findings }));
    expect(result.pass).toBe(false);
    expect(result.missed.map((entry) => entry.id)).toEqual(['b']);
  });

  test('a case file that does not parse fails the run instead of shrinking the eval set', () => {
    const cases = { ...twoCases(), 'c.json': '{ not json' };
    const result = run(fakeRepo({ cases, findings: bothFound() }));
    expect(result.pass).toBe(false);
    expect(result.problems).toContain('unloadable-case-file');
    expect(result.unloadable).toHaveLength(1);
  });

  test('a case no CODEOWNERS owner confirmed is invalid and fails the run', () => {
    const cases = { ...twoCases(), 'a.json': evalCase('a', { confirmedBy: 'someone-else', location: { path: 'src/a.js', startLine: 10, endLine: 20 } }) };
    const result = run(fakeRepo({ cases, findings: bothFound() }));
    expect(result.pass).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining(['invalid-case', 'important-finding-lost']));
    expect(result.invalid[0].errors).toEqual([{ field: 'confirmedBy', reason: 'confirmed-by-not-owner' }]);
  });

  test('a case file whose name does not match its id is invalid', () => {
    const cases = { 'a.json': evalCase('other', { location: { path: 'src/a.js', startLine: 10, endLine: 20 } }) };
    const result = run(fakeRepo({ cases, findings: { other: [important('other')] } }));
    expect(result.invalid[0].errors).toEqual([{ field: 'path', reason: 'case-filename-mismatch' }]);
  });

  test('an empty case directory or an unreadable findings file is a failure, never a pass', () => {
    expect(run(fakeRepo({ cases: {}, findings: {} })).pass).toBe(false);
    const repo = fakeRepo({ cases: twoCases(), findings: bothFound() });
    repo.files.set('/out/findings.json', 'not json');
    expect(run(repo)).toMatchObject({ pass: false, ok: false });
    repo.files.set('/out/findings.json', JSON.stringify({ findings: [] }));
    expect(run(repo)).toMatchObject({ pass: false, ok: false });
  });

  describe('pinned commits (base drift cannot silently invalidate a case)', () => {
    test('a case with no 40-hex commit in `change` fails', () => {
      const cases = { 'a.json': evalCase('a', { change: 'PR 1', location: { path: 'src/a.js', startLine: 10, endLine: 20 } }) };
      const result = run(fakeRepo({ cases, findings: { a: [important('a')] } }));
      expect(result.pass).toBe(false);
      expect(result.problems).toContain('case-not-pinned-to-a-commit');
      expect(result.pins.a.status).toBe('no-pinned-sha');
    });

    test('a recorded range past the end of the file at the pinned commit fails', () => {
      const repo = fakeRepo({ cases: twoCases(), findings: bothFound(), commits: { [SHA]: { 'src/a.js': 100, 'src/b.js': 12 } } });
      const result = run(repo);
      expect(result.pass).toBe(false);
      expect(result.pins.b).toMatchObject({ status: 'pin-mismatch', reason: 'file-has-12-lines' });
      expect(result.pins.a.status).toBe('verified');
    });

    test('a file absent at the pinned commit fails', () => {
      const repo = fakeRepo({ cases: twoCases(), findings: bothFound(), commits: { [SHA]: { 'src/a.js': 100 } } });
      expect(run(repo).pins.b).toMatchObject({ status: 'pin-mismatch', reason: 'path-absent-at-pinned-commit' });
    });

    test('a commit this checkout lacks (shallow clone) is `unverifiable`, never `verified`, and does not fail the run', () => {
      const result = run(fakeRepo({ cases: twoCases(), findings: bothFound(), commits: {} }));
      expect(result.pins.a).toEqual({ status: 'unverifiable', sha: SHA });
      expect(result.pass).toBe(true);
    });

    test('checkPin takes the first 40-hex run and ignores a longer hex string', () => {
      const deps = { git: () => ({ status: 1, stdout: '', stderr: '' }) };
      expect(checkPin(deps, '/r', { change: `x ${'b'.repeat(41)}`, location: { path: 'p', endLine: 1 } }).status).toBe('no-pinned-sha');
    });
  });

  describe('stale cases (the rules file moved: owner re-review)', () => {
    test('are reported with their reason and do not fail the run by default', () => {
      const result = run(fakeRepo({ cases: twoCases(), findings: bothFound(), rulesHash: 'rules-hash-2' }));
      expect(result.stale.sort()).toEqual(['a', 'b']);
      expect(result.staleReasons).toEqual({ a: 'rules-hash-changed', b: 'rules-hash-changed' });
      expect(result.pass).toBe(true);
    });

    test('fail the run under failOnStale', () => {
      const result = run(fakeRepo({ cases: twoCases(), findings: bothFound(), rulesHash: 'rules-hash-2' }), { failOnStale: true });
      expect(result.pass).toBe(false);
      expect(result.problems).toEqual(['stale-case']);
    });

    test('an unreadable rules file makes the cases stale, never current', () => {
      const repo = fakeRepo({ cases: twoCases(), findings: bothFound() });
      repo.files.delete('/repo/REVIEW.md');
      expect(run(repo).staleReasons).toEqual({ a: 'rules-file-unknown', b: 'rules-file-unknown' });
    });
  });

  describe('eval history (the false-negative rate over time)', () => {
    test('records every run, failures included, and the next run is compared with it', () => {
      const first = fakeRepo({ cases: twoCases(), findings: { a: [important('a')], b: [] } });
      const failed = run(first, { historyPath: '/out/history.jsonl', reviewer: 'candidate' });
      expect(failed.historyRecorded).toBe(true);
      const entry = JSON.parse(first.appended[0]);
      expect(entry).toMatchObject({ reviewer: 'candidate', found: 1, total: 2, falseNegativeRate: 0.5, missed: ['b'], pass: false });
      expect(entry.cases).toEqual([{ id: 'a', found: true }, { id: 'b', found: false }]);
    });

    test('a case found by the previous run and lost now is a regression naming it', () => {
      const previous = `${JSON.stringify({ cases: [{ id: 'a', found: true }, { id: 'b', found: true }] })}\n`;
      const result = run(fakeRepo({ cases: twoCases(), findings: { a: [important('a')], b: [] }, history: previous }), { historyPath: '/out/history.jsonl' });
      expect(result.comparison).toMatchObject({ regression: true, flipped: [{ id: 'b', from: true, to: false }] });
      expect(result.problems).toContain('regression-against-previous-run');
    });

    test('deleting a case file to dodge the guard is a regression against history, not a smaller passing set', () => {
      const previous = `${JSON.stringify({ cases: [{ id: 'a', found: true }, { id: 'b', found: true }] })}\n`;
      const cases = { 'a.json': twoCases()['a.json'] };
      const result = run(fakeRepo({ cases, findings: { a: [important('a')] }, history: previous }), { historyPath: '/out/history.jsonl' });
      expect(result.found).toBe(1);
      expect(result.missed).toEqual([]);
      expect(result.comparison.missing).toEqual(['b']);
      expect(result.pass).toBe(false);
      expect(result.problems).toEqual(['regression-against-previous-run']);
    });

    test('gaining a case is not a regression', () => {
      const previous = `${JSON.stringify({ cases: [{ id: 'a', found: true }] })}\n`;
      const result = run(fakeRepo({ cases: twoCases(), findings: bothFound(), history: previous }), { historyPath: '/out/history.jsonl' });
      expect(result.comparison).toMatchObject({ regression: false, added: ['b'] });
      expect(result.pass).toBe(true);
    });

    test('a corrupt last history entry fails the run and appends nothing', () => {
      const repo = fakeRepo({ cases: twoCases(), findings: bothFound(), history: 'not json\n' });
      const result = run(repo, { historyPath: '/out/history.jsonl' });
      expect(result.pass).toBe(false);
      expect(result.problems).toContain('eval-history-unreadable');
      expect(repo.appended).toEqual([]);
    });

    test('without a history path nothing is read or written', () => {
      const repo = fakeRepo({ cases: twoCases(), findings: bothFound() });
      const result = run(repo);
      expect(result.comparison).toBeNull();
      expect(repo.appended).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// The committed eval set, through the real entry point.
// ---------------------------------------------------------------------------

const CASES_DIR = path.join(REPO_ROOT, 'docs', 'review-eval', 'cases');
const BASELINE = path.join(REPO_ROOT, 'docs', 'review-eval', 'baselines', 'deep-review-reconstructed.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const guardCli = (args) => {
  const result = spawnSync(process.execPath, [GUARD, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status, out: result.stdout.trim() === '' ? null : JSON.parse(result.stdout) };
};

describe('the committed eval set (#228, #233, #234 findings)', () => {
  const caseFiles = fs.readdirSync(CASES_DIR).filter((name) => name.endsWith('.json')).sort();
  const cases = caseFiles.map((name) => readJson(path.join(CASES_DIR, name)));
  const codeowners = fs.readFileSync(path.join(REPO_ROOT, '.github', 'CODEOWNERS'), 'utf8');
  let scratch;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-guard-'));
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  test('covers PR 228, PR 233 and PR 234 and every case is valid, confirmed by a CODEOWNERS owner, in the eval directory', () => {
    const changes = cases.map((record) => /pull\/(\d+)/.exec(record.change)[1]);
    expect(new Set(changes)).toEqual(new Set(['228', '233', '234']));
    cases.forEach((record, index) => {
      const verdict = validateCase({ case: record, codeowners, path: `docs/review-eval/cases/${caseFiles[index]}` });
      expect({ id: record.id, errors: verdict.errors }).toEqual({ id: record.id, errors: [] });
    });
  });

  test('stale detection fires on the committed cases when their rules file changes', () => {
    const changed = staleCases({ cases, rulesHashes: { 'REVIEW.md': 'a-different-hash' } });
    expect(changed.stale).toHaveLength(cases.length);
    expect(Object.values(changed.reasons)).toEqual(Array(cases.length).fill('rules-hash-changed'));
    const unchanged = staleCases({ cases, rulesHashes: { 'REVIEW.md': cases[0].rulesHash } });
    expect(unchanged.stale).toEqual([]);
  });

  test('the guard passes on the reconstructed deep-review output: exit 0, false-negative rate 0, no pin mismatch', () => {
    const { status, out } = guardCli(['--findings', BASELINE]);
    expect(out.invalid).toEqual([]);
    expect(out.unloadable).toEqual([]);
    expect(Object.values(out.pins).filter((pin) => pin.status === 'pin-mismatch' || pin.status === 'no-pinned-sha')).toEqual([]);
    expect({ status, pass: out.pass, found: out.found, cases: out.cases, rate: out.falseNegativeRate }).toEqual({
      status: 0,
      pass: true,
      found: cases.length,
      cases: cases.length,
      rate: 0,
    });
  });

  test.each(cases.map((record) => [record.id]))('removing the expected Important finding for %s makes the guard exit 1 naming it', (id) => {
    const mutated = readJson(BASELINE);
    mutated.findingsByCase[id] = mutated.findingsByCase[id].filter((entry) => entry.severity !== 'Important');
    const file = path.join(scratch, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(mutated));
    const { status, out } = guardCli(['--findings', file]);
    expect(status).toBe(1);
    expect(out.pass).toBe(false);
    expect(out.missed.map((entry) => entry.id)).toEqual([id]);
    expect(out.found).toBe(cases.length - 1);
  });

  test('exit codes: 2 for bad usage, 1 for an unreadable findings file', () => {
    expect(guardCli([]).status).toBe(2);
    expect(guardCli(['--findings', path.join(scratch, 'absent.json')]).status).toBe(1);
  });

  test('main returns the exit code and prints one JSON object', () => {
    const writes = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((text) => {
      writes.push(text);
      return true;
    });
    let code;
    try {
      code = main(['--findings', BASELINE, '--repo', REPO_ROOT]);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).pass).toBe(true);
  });
});
