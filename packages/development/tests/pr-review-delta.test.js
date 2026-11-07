'use strict';

/**
 * Tests for planDeltaReview and the import graph it consumes (kata 801a). Every fail-closed rule has its own
 * test: removing the rule must make that test (and only that rule's tests) fail.
 */

const { planDeltaReview } = require('../lib/pr-review-delta');
const { buildImportGraph, specifiersOf } = require('../lib/pr-review-import-graph');
const { chooseReviewRange } = require('../lib/pr-review-scope');
const { classifyPaths } = require('../lib/pr-review-paths');

const BASE = 'b'.repeat(40);
const REVIEWED = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);

const deltaRange = (overrides = {}) => ({
  ok: true,
  mode: 'delta',
  range: `${REVIEWED}..${HEAD}`,
  fullRange: `${BASE}...${HEAD}`,
  baseSha: BASE,
  headSha: HEAD,
  lastReviewedSha: REVIEWED,
  reason: 'delta-since-last-review',
  unvouched: [],
  ...overrides,
});

const DECLARATION = { sourceSha: BASE, sensitive: ['secure/**'], high: ['core/**'] };
const classify = (changedPaths) => classifyPaths({ changedPaths, declaration: DECLARATION, baseSha: BASE });

const FILES = [
  'src/thing.js',
  'src/app.js',
  'src/other.js',
  'src/util/index.js',
  'src/use-util.js',
  'tests/thing.test.js',
  'tests/app-flow.test.js',
  'tests/stem/thing.spec.js',
  'core/engine.js',
  'secure/keys.js',
];
const LINES = [
  { path: 'src/app.js', text: "const thing = require('./thing');" },
  { path: 'src/other.js', text: "const x = require('./unrelated');" },
  { path: 'src/use-util.js', text: "import { u } from './util';" },
  { path: 'tests/app-flow.test.js', text: "const thing = require('../src/thing.js');" },
];
const graph = (overrides = {}) => ({ ...buildImportGraph({ filePaths: FILES, lines: LINES }), ...overrides });

function plan(overrides = {}) {
  const changedPaths = overrides.changedPaths || ['src/thing.js'];
  return planDeltaReview({
    delta: deltaRange(),
    changedPaths,
    pathsClassification: classify(changedPaths),
    reviewed: { headSha: REVIEWED },
    importGraph: graph(),
    ...overrides,
  });
}

const readPaths = (result) => result.readSet.map((entry) => entry.path);

describe('planDeltaReview: the delta plus its blast radius (AC1)', () => {
  it('reads the changed file, the files that import it and the tests that import it or carry its name', () => {
    const result = plan();
    expect(result.mode).toBe('delta');
    expect(readPaths(result)).toEqual(['src/app.js', 'src/thing.js', 'tests/app-flow.test.js', 'tests/stem/thing.spec.js', 'tests/thing.test.js']);
    const byPath = Object.fromEntries(result.readSet.map((entry) => [entry.path, entry.reasons]));
    expect(byPath['src/thing.js']).toEqual(['changed']);
    expect(byPath['src/app.js']).toEqual(['caller-of:src/thing.js']);
    expect(byPath['tests/app-flow.test.js']).toEqual(['test-of:src/thing.js']);
    expect(byPath['tests/thing.test.js']).toEqual(['test-of:src/thing.js']);
  });

  it('does not read what neither imports nor tests a changed file', () => {
    expect(readPaths(plan())).not.toContain('src/other.js');
  });

  it('finds the importers of a directory module through its index file', () => {
    expect(readPaths(plan({ changedPaths: ['src/util/index.js'] }))).toContain('src/use-util.js');
  });

  it('still names the importers of a file the delta deleted', () => {
    const lines = [...LINES, { path: 'src/other.js', text: "const gone = require('./removed');" }];
    const importGraph = buildImportGraph({ filePaths: FILES, lines });
    const result = plan({ changedPaths: ['src/removed.js'], importGraph });
    expect(result.mode).toBe('delta');
    expect(readPaths(result)).toEqual(['src/other.js', 'src/removed.js']);
  });

  it('keeps a changed test file in the read set as changed', () => {
    const result = plan({ changedPaths: ['tests/thing.test.js'] });
    expect(result.readSet).toEqual([{ path: 'tests/thing.test.js', reasons: ['changed'] }]);
  });

  it('lists the read set in byte order with no path twice', () => {
    const result = plan({ changedPaths: ['src/thing.js', 'src/app.js'] });
    expect(readPaths(result)).toEqual([...new Set(readPaths(result))].sort());
    expect(result.readSet.find((entry) => entry.path === 'src/app.js').reasons).toEqual(['caller-of:src/thing.js', 'changed']);
  });
});

describe('planDeltaReview: fails closed to a full re-read (AC1, AC2)', () => {
  const expectFull = (result, ...reasons) => {
    expect(result.mode).toBe('full');
    expect(result.readSet).toEqual([]);
    for (const reason of reasons) expect(result.reasons).toContain(reason);
  };

  it('a last reviewed head the review state does not record as reviewed (AC1: a head never seen)', () => {
    for (const reviewed of [undefined, null, {}, { headSha: null }, { headSha: true }, { headSha: 'main' }]) {
      expectFull(plan({ reviewed }), 'head-never-seen');
    }
  });

  it('a record for another head does not make this one seen, however readable that other commit is', () => {
    expectFull(plan({ reviewed: { headSha: 'e'.repeat(40) } }), 'head-never-seen');
    expectFull(plan({ reviewed: { headSha: HEAD } }), 'head-never-seen');
  });

  it('the record names the delta head whatever the case of its hex', () => {
    expect(plan({ reviewed: { headSha: REVIEWED.toUpperCase() } }).mode).toBe('delta');
  });

  it('a delta touching a High path', () => {
    expectFull(plan({ changedPaths: ['src/thing.js', 'core/engine.js'], pathsClassification: classify(['src/thing.js', 'core/engine.js']) }), 'high-path-touched');
  });

  it('a delta touching a sensitive path', () => {
    expectFull(plan({ changedPaths: ['secure/keys.js'], pathsClassification: classify(['secure/keys.js']) }), 'sensitive-path-touched');
  });

  it('a delta touching a review declaration file', () => {
    const changedPaths = ['REVIEW.md'];
    const pathsClassification = { ok: true, paths: [{ path: 'REVIEW.md', sensitive: false, high: false, declarationFile: true }] };
    expectFull(plan({ changedPaths, pathsClassification }), 'sensitive-path-touched');
  });

  it('a classification that is unreadable, not ok, or that does not cover every changed path', () => {
    expectFull(plan({ pathsClassification: undefined }), 'classification-unreadable');
    expectFull(plan({ pathsClassification: { ...classify(['src/thing.js']), ok: false } }), 'classification-unreadable');
    expectFull(plan({ pathsClassification: { ok: true } }), 'classification-unreadable');
    expectFull(plan({ changedPaths: ['src/thing.js', 'src/app.js'], pathsClassification: classify(['src/thing.js']) }), 'classification-incomplete');
  });

  it('changed paths that are missing, malformed or empty', () => {
    expectFull(plan({ changedPaths: undefined }), 'changed-paths-unreadable');
    expectFull(plan({ changedPaths: ['src/thing.js', 42] }), 'changed-paths-unreadable');
    expectFull(plan({ changedPaths: ['src/thing.js', ''] }), 'changed-paths-unreadable');
    expectFull(plan({ changedPaths: [], pathsClassification: classify([]) }), 'empty-delta');
  });

  it('an import graph that is missing or unreadable: no blast radius, no justified read set', () => {
    expectFull(plan({ importGraph: undefined }), 'import-graph-unavailable');
    expectFull(plan({ importGraph: null }), 'import-graph-unavailable');
    expectFull(plan({ importGraph: { schema: 1, importers: { a: 'b' }, testFiles: [] } }), 'import-graph-unreadable');
    expectFull(plan({ importGraph: { schema: 2, importers: {}, testFiles: [] } }), 'import-graph-unreadable');
    expectFull(plan({ importGraph: { schema: 1, importers: {} } }), 'import-graph-unreadable');
  });

  it('a delta that changes source in a language the graph does not read', () => {
    for (const file of ['lib/thing.py', 'scripts/run.sh', 'app/x.ex']) {
      expectFull(plan({ changedPaths: [file], pathsClassification: classify([file]) }), 'unanalyzed-source-changed');
    }
  });

  it('a range decision that is not a readable delta', () => {
    expectFull(plan({ delta: undefined }), 'delta-unreadable');
    expectFull(plan({ delta: { ok: false, status: 'REVIEW_BLOCKED' } }), 'delta-unreadable');
    expectFull(plan({ delta: deltaRange({ lastReviewedSha: 'main' }) }), 'delta-unreadable');
    expectFull(plan({ delta: deltaRange({ headSha: undefined }) }), 'delta-unreadable');
  });

  it('every applicable reason is reported, none is dropped', () => {
    const result = plan({ reviewed: undefined, importGraph: undefined, changedPaths: ['core/engine.js'], pathsClassification: classify(['core/engine.js']) });
    expect(result.reasons).toEqual(expect.arrayContaining(['head-never-seen', 'high-path-touched', 'import-graph-unavailable']));
  });

  it('never throws on garbage input', () => {
    for (const input of [undefined, null, 7, 'x', [], {}]) expect(planDeltaReview(input).mode).toBe('full');
  });
});

describe('planDeltaReview composes with chooseReviewRange (AC3)', () => {
  const scope = { baseSha: BASE, headSha: HEAD };
  const commit = (sha, parents) => ({ sha, parents });

  it('a full range from review-range is never overridden to delta, whatever else is true', () => {
    for (const request of [
      { ...scope },
      { ...scope, lastReviewedSha: 'main' },
      { ...scope, lastReviewedSha: REVIEWED },
      { ...scope, lastReviewedSha: REVIEWED, commits: [commit(HEAD, [REVIEWED])], remediationShas: [] },
    ]) {
      const range = chooseReviewRange(request);
      expect(range.mode).toBe('full');
      const result = plan({ delta: range });
      expect(result.mode).toBe('full');
      expect(result.reasons).toEqual(expect.arrayContaining(['range-is-full', range.reason]));
    }
  });

  it('a vouched delta from review-range is refined, not replaced: same reason, a non-empty read set', () => {
    const range = chooseReviewRange({ ...scope, lastReviewedSha: REVIEWED, commits: [commit(HEAD, [REVIEWED])], remediationShas: [HEAD] });
    expect(range.mode).toBe('delta');
    const result = plan({ delta: range });
    expect(result.mode).toBe('delta');
    expect(result.reasons).toEqual(['delta-since-last-review']);
    expect(result.readSet.length).toBeGreaterThan(0);
  });
});

describe('buildImportGraph', () => {
  const build = (lines, filePaths = FILES) => buildImportGraph({ filePaths, lines });

  it('reads require, import, dynamic import and re-export specifiers, relative only', () => {
    expect(specifiersOf("const a = require('./a'); const b = require(\"../b\");")).toEqual(['./a', '../b']);
    expect(specifiersOf("import x from './x';")).toEqual(['./x']);
    expect(specifiersOf("} from './multi-line';")).toEqual(['./multi-line']);
    expect(specifiersOf("import './side-effect';")).toEqual(['./side-effect']);
    expect(specifiersOf("const m = await import('./lazy.js');")).toEqual(['./lazy.js']);
    expect(specifiersOf("export * from './re';")).toEqual(['./re']);
    expect(specifiersOf("const fs = require('fs'); import pkg from '@scope/pkg';")).toEqual([]);
    expect(specifiersOf('const t = require(`./${name}`);')).toEqual([]);
  });

  it('resolves an extensionless specifier, an explicit one and a directory to the tracked file', () => {
    const g = build([
      { path: 'src/app.js', text: "require('./thing')" },
      { path: 'src/use-util.js', text: "require('./util')" },
      { path: 'tests/thing.test.js', text: "require('../src/thing.js')" },
    ]);
    expect(g.importers['src/thing.js']).toEqual(['src/app.js', 'tests/thing.test.js']);
    expect(g.importers['src/util/index.js']).toEqual(['src/use-util.js']);
  });

  it('prefers the file a specifier names exactly over the same name plus an extension', () => {
    const g = build([{ path: 'src/user.js', text: "require('./data')" }], ['src/data', 'src/data.js', 'src/user.js']);
    expect(g.importers).toEqual({ 'src/data': ['src/user.js'] });
  });

  it('resolves a TypeScript specifier that names the compiled extension', () => {
    const g = build([{ path: 'src/a.ts', text: "import { b } from './b.js';" }], ['src/a.ts', 'src/b.ts']);
    expect(g.importers['src/b.ts']).toEqual(['src/a.ts']);
  });

  it('keys an unresolvable relative specifier by its normalized path and drops one that leaves the repository', () => {
    const g = build([
      { path: 'src/a.js', text: "require('./gone')" },
      { path: 'src/b.js', text: "require('../../../escape')" },
    ]);
    expect(g.importers).toEqual({ 'src/gone': ['src/a.js'] });
  });

  it('ignores a file importing itself and lines it cannot read', () => {
    const g = build([{ path: 'src/a.js', text: "require('./a')" }, { path: '', text: "require('./x')" }, { path: 'src/c.js' }, null], ['src/a.js']);
    expect(g.importers).toEqual({});
  });

  it('lists every tracked test file for the name match, and is the same for the same input', () => {
    const a = build(LINES);
    expect(a.testFiles).toEqual(['tests/app-flow.test.js', 'tests/stem/thing.spec.js', 'tests/thing.test.js']);
    expect(JSON.stringify(build(LINES.slice().reverse()))).toBe(JSON.stringify(a));
  });
});
