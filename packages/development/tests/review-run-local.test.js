'use strict';

/**
 * The LOCAL review (`reviewId`, no pull request) of `review-run-cli`, through the real CLI process.
 *
 * `implement-trd-tasks` reviews the whole branch BEFORE the completion pull request exists (phase 5, step 5.2),
 * and `implement close` reads that review at `.ensemble/pr-review/pr-<slug>-completion.json`. The numbered-PR runner
 * needs an open GitHub pull request, so it has a second mode keyed by an id of the caller's choosing. This file pins
 * what that mode skips (every host read) and what it keeps (the head check, the report and head validation, the refusal
 * of anything that is not a file-name-safe id).
 *
 * Real: git (an origin, a clone, a feature branch with a test file), the CLI process, prepare, the result collector,
 * the state report. Faked: the agents (this test writing `out-<name>.json`) and `gh` -- by a stub that records every
 * call and FAILS it, so a local review that reached for the host would be seen at once.
 *
 * Fixtures live under ~/.omp/pr-review-speedup/local/fixtures (never /tmp) and are removed afterwards.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

jest.setTimeout(240000);

const CLI = path.join(__dirname, '..', 'lib', 'review-run-cli.js');
const FIXTURES = path.join(os.homedir(), '.omp', 'pr-review-speedup', 'local', 'fixtures');
const SEVERITY = '## Severity\n\n- **Important** — fixture-important: the change is wrong.\n- **Nit** — fixture-nit: a preference.\n- **Pre-existing** — fixture-pre: not this PR.\n\n';
const POLICY = `# Review\n\n${SEVERITY}\`\`\`ensemble-review-policy\n{"sensitivePaths":["secure/**"],"highPaths":["wide/**"]}\n\`\`\`\n`;
const REVIEW_ID = 'widget-engine-completion';

/** A `gh` that records its argv and fails: a local review must never call the host. */
const GH_STUB = `#!/usr/bin/env node
require('fs').appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('gh must not be called by a local review\\n');
process.exit(1);
`;

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const write = (cwd, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), text);
};

let fx;

function buildFixture() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURES, 'local-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', origin);
  write(work, 'README.md', '# fixture\n');
  write(work, 'REVIEW.md', POLICY);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  write(work, 'src/widget.js', 'module.exports = () => 1;\n');
  write(work, 'src/widget.test.js', "if (require('./widget')() !== 1) process.exit(1);\n");
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'the widget and its test');
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.ensemble/\n');
  return {
    bin,
    logFile: path.join(root, 'gh.log'),
    root,
    work,
    head: git(work, 'rev-parse', 'HEAD'),
    base: git(work, 'rev-parse', 'main'),
  };
}

beforeAll(() => {
  fx = buildFixture();
});

afterAll(() => {
  spawnSync('chmod', ['-R', 'u+w', fx.root]);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(fx.logFile, '');
  git(fx.work, 'checkout', '-q', '-B', 'feature', fx.head);
  // prepare seals its snapshot read-only: make it removable first
  spawnSync('chmod', ['-R', 'u+w', path.join(fx.work, '.ensemble')]);
  fs.rmSync(path.join(fx.work, '.ensemble'), { force: true, recursive: true });
});

const cliEnv = () => ({ ...process.env, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, STUB_GH_LOG: fx.logFile, GIT_CONFIG_GLOBAL: '/dev/null' });

function cli(command, payload) {
  const result = spawnSync(process.execPath, [CLI, command], { cwd: fx.root, encoding: 'utf8', env: cliEnv(), input: JSON.stringify(payload), timeout: 180000 });
  let out;
  try {
    out = JSON.parse(result.stdout);
  } catch {
    out = { stderr: result.stderr, unparsable: result.stdout };
  }
  return { code: result.status, out };
}

const WITH_NODE = { testCommand: [process.execPath], testFiles: ['src/widget.test.js'] };
const prep = (runId, extra = {}) => cli('prepare', { baseSha: fx.base, repoRoot: fx.work, reviewId: REVIEW_ID, runId, ...WITH_NODE, ...extra });
const coll = (runId, extra = {}) => cli('collect', { repoRoot: fx.work, runId, ...extra });
const reportFile = (id = REVIEW_ID) => path.join(fx.work, '.ensemble', 'pr-review', `pr-${id}.json`);
const ghCalls = () => fs.readFileSync(fx.logFile, 'utf8').split('\n').filter(Boolean);

function answer(manifest, findings = {}) {
  for (const agent of manifest.agents) {
    fs.mkdirSync(path.dirname(agent.outPath), { recursive: true });
    fs.writeFileSync(agent.outPath, JSON.stringify({ findings: findings[agent.name] || [], pathsReviewed: agent.paths || ['src/widget.js', 'src/widget.test.js'] }));
  }
}

describe('a local review runs the whole loop without a pull request', () => {
  test('prepare, the agents, collect: DONE and LOCAL_REVIEW_COMPLETE, the report keyed by the id, and the host never called', () => {
    const prepared = prep('local-run');
    expect(prepared.code).toBe(0);
    expect(prepared.out).toMatchObject({ ok: true, status: 'DISPATCH', headSha: fx.head });
    expect(prepared.out.agents.length).toBeGreaterThan(0);

    answer(prepared.out);
    const done = coll('local-run');
    expect(done.code).toBe(0);
    expect(done.out).toMatchObject({ ok: true, status: 'DONE', reviewStatus: { localPhase: 'LOCAL_REVIEW_COMPLETE' } });

    // The report is where `implement close` reads it, and it is the report of THIS head.
    const report = JSON.parse(fs.readFileSync(reportFile(), 'utf8'));
    expect(report).toMatchObject({ prId: REVIEW_ID, headSha: fx.head, localPhase: 'LOCAL_REVIEW_COMPLETE' });

    // Nothing of a pull request was read or posted.
    expect(ghCalls()).toEqual([]);
    // Its gate says what it is: reviews and branch protection were not readable, never a stand-in.
    expect(done.out.gate.mergeable).toBe(false);
    expect(done.out.gate.blockers.length).toBeGreaterThan(0);
  });

  test('the reviewers still decide: an open finding leaves the local review incomplete', () => {
    const prepared = prep('local-finding');
    expect(prepared.code).toBe(0);
    const reviewer = prepared.out.agents.find((agent) => agent.paths && agent.paths.includes('src/widget.js'));
    answer(prepared.out, {
      [reviewer.name]: [
        {
          locationOrLink: 'src/widget.js:1',
          severity: 'important',
          failureMode: 'The widget returns a constant, so the caller can never see a different value no matter what it passes in.',
          disposition: 'fix',
          evidence: 'Called widget() with every input: always 1.',
        },
      ],
    });
    // A finding goes to verifiers first; every one of them confirms it is real.
    const verify = coll('local-finding');
    expect(verify.out).toMatchObject({ ok: true, status: 'DISPATCH', round: 'verify' });
    for (const agent of verify.out.agents) {
      fs.writeFileSync(agent.outPath, JSON.stringify({ votes: agent.candidateIds.map((id) => ({ candidateId: id, verdict: 'real', evidence: 'read it' })) }));
    }
    const done = coll('local-finding');
    expect(done.out).toMatchObject({ ok: true, status: 'DONE' });
    expect(done.out.ledger).toHaveLength(1);
    expect(done.out.reviewStatus.localPhase).not.toBe('LOCAL_REVIEW_COMPLETE');
    expect(JSON.parse(fs.readFileSync(reportFile(), 'utf8')).localPhase).not.toBe('LOCAL_REVIEW_COMPLETE');
  });
});

describe('the head still has to be the head that was reviewed', () => {
  test('a head that moved before collect is RUN_INVALIDATED, and the report of the old head is not written', () => {
    const prepared = prep('local-moved');
    expect(prepared.code).toBe(0);
    answer(prepared.out);
    write(fx.work, 'src/other.js', 'module.exports = 2;\n');
    git(fx.work, 'add', '.');
    git(fx.work, 'commit', '-q', '-m', 'a later commit');

    const collected = coll('local-moved');
    expect(collected.code).toBe(1);
    expect(collected.out).toMatchObject({ ok: false, status: 'RUN_INVALIDATED', reason: 'head-moved', expectedHead: fx.head });
    expect(fs.existsSync(reportFile())).toBe(false);
  });

  test('a head that moves AFTER the review finished invalidates its stored answer, and a moved-back head restores it', () => {
    const prepared = prep('local-finished');
    answer(prepared.out);
    expect(coll('local-finished').out).toMatchObject({ status: 'DONE' });

    write(fx.work, 'src/other.js', 'module.exports = 2;\n');
    git(fx.work, 'add', '.');
    git(fx.work, 'commit', '-q', '-m', 'a later commit');
    expect(coll('local-finished').out).toMatchObject({ ok: false, status: 'RUN_INVALIDATED', reason: 'head-moved' });

    git(fx.work, 'checkout', '-q', '-B', 'feature', fx.head);
    expect(coll('local-finished').out).toMatchObject({ ok: true, status: 'DONE' });
  });
});

describe('a local review key is a file name, never a path', () => {
  test.each([
    ['a path separator', 'a/b'],
    ['a parent traversal', '../escape'],
    ['an absolute path', '/etc/passwd'],
    ['a dot', 'widget.completion'],
    ['a leading dash', '-flag'],
    ['an empty id', ''],
    ['a number', 7],
  ])('%s is refused as invalid input, before anything is read or written', (_label, reviewId) => {
    const refused = prep('local-bad-id', { reviewId });
    expect(refused.code).toBe(1);
    expect(refused.out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'invalid-input' });
    expect(fs.existsSync(path.join(fx.work, '.ensemble', 'pr-review', 'run', 'local-bad-id'))).toBe(false);
    expect(fs.existsSync(path.join(fx.root, 'escape.json'))).toBe(false);
    expect(ghCalls()).toEqual([]);
  });

  test('a reviewId run takes neither a repo nor a pull request, and a numbered run takes no baseRef', () => {
    const both = prep('local-mixed', { repo: 'o/r', pr: 7 });
    expect(both.out).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(both.out.error).toContain('neither repo nor pr');
    const numbered = cli('prepare', { baseRef: 'main', baseSha: fx.base, pr: 7, repo: 'o/r', repoRoot: fx.work });
    expect(numbered.out).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(numbered.out.error).toContain('baseRef');
  });

  test('a baseRef that is not a plain branch name is refused', () => {
    for (const baseRef of ['--upload-pack=x', 'a b', 'a..b', 'a:b']) {
      expect(prep('local-bad-ref', { baseRef }).out).toMatchObject({ ok: false, reason: 'invalid-input' });
    }
  });
});

describe('what the local review cannot read stays an outage, never a pass', () => {
  test('a base that is not a ref of this clone is refused: nothing is fetched to make it exist', () => {
    const refused = prep('local-no-base', { baseRef: 'no-such-branch' });
    expect(refused.code).toBe(1);
    expect(refused.out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'refs-unavailable' });
    expect(refused.out.error).toContain('no-such-branch');
  });

  test('a repository git cannot read is RUN_FAILED head-unreadable, not an empty review', () => {
    const notARepo = path.join(fx.root, 'not-a-repo');
    fs.mkdirSync(notARepo, { recursive: true });
    const refused = cli('prepare', { baseSha: fx.base, repoRoot: notARepo, reviewId: REVIEW_ID, runId: 'local-no-git', ...WITH_NODE });
    expect(refused.code).toBe(1);
    expect(refused.out).toMatchObject({ ok: false, status: 'RUN_FAILED' });
    expect(['pr-unreadable', 'head-unreadable']).toContain(refused.out.reason);
    expect(fs.existsSync(reportFile())).toBe(false);
  });

  test('a stated baseSha that is not the merge base is still refused', () => {
    const refused = prep('local-bad-base', { baseSha: fx.head });
    expect(refused.out).toMatchObject({ ok: false, reason: 'base-not-merge-base' });
  });
});
