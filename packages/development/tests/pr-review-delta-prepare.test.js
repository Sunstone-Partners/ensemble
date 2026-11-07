'use strict';

/**
 * The delta plan through the real preparation step (kata 801a): a real git repository, the real `git`, and
 * pr-review-prepare-cli.js as an entry point. facts.json `deltaPlan` is what a re-review reads, so these tests run
 * prepare and read what it published, never a hand-built plan.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { prepareReview, removePrepared, defaultDeps } = require('../lib/pr-review-prepare');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-prepare-cli.js');
const NODE_TEST = [process.execPath, '--test'];
const POLICY = '# Review\n\n```ensemble-review-policy\n{"sensitivePaths":["secure/**"],"highPaths":["core/**"]}\n```\n';
const roots = [];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * base -> reviewed (R) -> head. `change(root)` makes the head commit, a remediation commit on top of R.
 * The repository holds a module with an importer, a test that imports it, a test that only carries its name, an
 * unrelated module and a module whose name has a space in it.
 */
function fixture(change) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-prepare-'));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'REVIEW.md', POLICY);
  write(root, 'src/thing.js', "module.exports = () => 'v0';\n");
  write(root, 'src/app.js', "const thing = require('./thing');\nmodule.exports = () => thing();\n");
  write(root, 'src/unrelated.js', 'module.exports = 1;\n');
  write(root, 'src/with space.js', 'module.exports = 2;\n');
  write(root, 'src/needs-space.js', "module.exports = require('./with space');\n");
  write(root, 'tests/app-flow.test.js', "require('../src/app');\n");
  write(root, 'tests/thing.test.js', "require('node:test')('thing', () => {});\n");
  write(root, 'core/engine.js', 'module.exports = 0;\n');
  write(root, 'secure/keys.js', 'module.exports = 0;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'src/unrelated.js', 'module.exports = 11;\n');
  git(root, ['commit', '-q', '-am', 'reviewed']);
  const reviewed = git(root, ['rev-parse', 'HEAD']);
  change(root);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'remediation']);
  const head = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/heads/pr', head]);
  return { root, base, reviewed, head };
}

const options = (fx, overrides = {}) => ({
  repoRoot: fx.root,
  runId: 'run-delta',
  baseSha: fx.base,
  headSha: fx.head,
  headRef: 'refs/heads/pr',
  lastReviewedSha: fx.reviewed,
  remediationShas: [fx.head],
  testCommand: NODE_TEST,
  nodeModules: path.join(fx.root, 'no-node-modules'),
  ...overrides,
});

function factsOf(result) {
  return JSON.parse(fs.readFileSync(result.artifacts['facts.json'].path, 'utf8'));
}

let tmp;
let tmpSpy;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-prepare-tmp-'));
  tmpSpy = jest.spyOn(os, 'tmpdir').mockReturnValue(tmp);
});
afterAll(() => {
  if (tmpSpy) tmpSpy.mockRestore();
  for (const r of roots.splice(0)) removePrepared(r);
  if (tmp) removePrepared(tmp);
});

describe('facts.json deltaPlan, from a real repository', () => {
  it('a vouched remediation commit is a delta whose read set holds the importers and the tests of what it changed', () => {
    const fx = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const result = prepareReview(options(fx));
    expect(result).toMatchObject({ ok: true, mode: 'delta' });
    const facts = factsOf(result);
    expect(facts.delta).toEqual({ lastReviewedSha: fx.reviewed, changedPaths: ['src/thing.js'], headSeenBefore: true });
    expect(facts.deltaPlan.mode).toBe('delta');
    expect(facts.deltaPlan.readSet.map((e) => e.path)).toEqual(['src/app.js', 'src/thing.js', 'tests/thing.test.js']);
    // the importer of the importer is not part of the radius, and nothing unrelated is read
    expect(facts.deltaPlan.readSet.map((e) => e.path)).not.toContain('tests/app-flow.test.js');
    expect(facts.deltaPlan.readSet.map((e) => e.path)).not.toContain('src/unrelated.js');
  });

  it('finds the importers of a file whose name has a space, and a deleted file keeps its importers', () => {
    const fx = fixture((root) => {
      write(root, 'src/with space.js', 'module.exports = 3;\n');
      fs.rmSync(path.join(root, 'src/unrelated.js'));
    });
    const facts = factsOf(prepareReview(options(fx)));
    expect(facts.deltaPlan.mode).toBe('delta');
    expect(facts.deltaPlan.readSet.map((e) => e.path)).toEqual(['src/needs-space.js', 'src/unrelated.js', 'src/with space.js']);
  });

  it('a delta touching a High path is a full re-read', () => {
    const fx = fixture((root) => {
      write(root, 'src/thing.js', "module.exports = () => 'v1';\n");
      write(root, 'core/engine.js', 'module.exports = 9;\n');
    });
    const facts = factsOf(prepareReview(options(fx)));
    expect(facts.deltaPlan).toEqual({ mode: 'full', reasons: ['high-path-touched'], readSet: [] });
  });

  it('a delta touching a sensitive path is a full re-read', () => {
    const fx = fixture((root) => write(root, 'secure/keys.js', 'module.exports = 9;\n'));
    expect(factsOf(prepareReview(options(fx))).deltaPlan.reasons).toEqual(['sensitive-path-touched']);
  });

  it('a delta that changes source the graph cannot read is a full re-read', () => {
    const fx = fixture((root) => write(root, 'tools/run.sh', '#!/bin/sh\necho hi\n'));
    expect(factsOf(prepareReview(options(fx))).deltaPlan.reasons).toEqual(['unanalyzed-source-changed']);
  });

  it('a last reviewed head this repository does not hold is a full re-read, never a delta', () => {
    const fx = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const never = 'd'.repeat(40);
    const result = prepareReview(options(fx, { lastReviewedSha: never }));
    expect(result).toMatchObject({ ok: true, mode: 'full' });
    const facts = factsOf(result);
    expect(facts.delta).toBeNull();
    expect(facts.deltaPlan).toMatchObject({ mode: 'full', readSet: [] });
    expect(facts.deltaPlan.reasons[0]).toBe('range-is-full');
  });

  it('the first round and a history nobody vouched for are full re-reads and keep the range reason', () => {
    const first = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const noLast = options(first);
    delete noLast.lastReviewedSha;
    expect(factsOf(prepareReview(noLast)).deltaPlan).toEqual({ mode: 'full', reasons: ['range-is-full', 'first-round'], readSet: [] });

    const unvouched = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const result = prepareReview(options(unvouched, { remediationShas: [] }));
    expect(factsOf(result).deltaPlan).toEqual({ mode: 'full', reasons: ['range-is-full', 'unvouched-history'], readSet: [] });
  });

  it('a repository scan that fails is a full re-read, not a failed preparation and not a delta with no radius', () => {
    const fx = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const real = defaultDeps();
    const deps = { ...real, git: (args, o) => (args[0] === 'grep' ? { status: 2, stdout: '', stderr: 'boom' } : real.git(args, o)) };
    const result = prepareReview(options(fx), deps);
    expect(result.ok).toBe(true);
    expect(factsOf(result).deltaPlan).toEqual({ mode: 'full', reasons: ['import-graph-unavailable'], readSet: [] });
  });

  it('a reviewed head the repository stops holding between the range decision and the plan is a full re-read', () => {
    const fx = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const real = defaultDeps();
    const lookup = `${fx.reviewed}^{commit}`;
    const deps = { ...real, git: (args, o) => (args[0] === 'rev-parse' && args.includes(lookup) ? { status: 1, stdout: '', stderr: '' } : real.git(args, o)) };
    const result = prepareReview(options(fx), deps);
    expect(result).toMatchObject({ ok: true, mode: 'delta' });
    const facts = factsOf(result);
    expect(facts.delta.headSeenBefore).toBe(false);
    expect(facts.deltaPlan).toEqual({ mode: 'full', reasons: ['head-never-seen'], readSet: [] });
  });

  it('the same inputs publish the same facts: the plan is part of what a reuse re-derives', () => {
    const fx = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const first = prepareReview(options(fx));
    const second = prepareReview(options(fx));
    expect(second.reused).toBe(true);
    expect(second.hashes['facts.json']).toBe(first.hashes['facts.json']);
  });
});

describe('through the entry point', () => {
  it('pr-review-prepare-cli.js prints the artifacts and its facts.json carries the plan', () => {
    const fx = fixture((root) => write(root, 'src/thing.js', "module.exports = () => 'v1';\n"));
    const run = spawnSync(process.execPath, [CLI], {
      cwd: fx.root,
      input: JSON.stringify({ ...options(fx), repoRoot: undefined }),
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out).toMatchObject({ ok: true, status: 'PREPARED', mode: 'delta' });
    expect(factsOf(out).deltaPlan.readSet.map((e) => e.path)).toEqual(['src/app.js', 'src/thing.js', 'tests/thing.test.js']);
  });
});
