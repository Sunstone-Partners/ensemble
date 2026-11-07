'use strict';

/**
 * The review-run CLI end to end (kata znd1), against a REAL throwaway git repository and the real CLI process.
 *
 * What is real: git (an origin, a clone with a base, a feature branch and a High branch), the CLI process, prepare (snapshot,
 * diffs, facts), the result-file collector, the state report and the run files. What is faked: `gh`, by an executable stub
 * first on PATH that answers the PR / reviews / branch-protection / statuses / comments endpoints from a JSON file the test
 * edits (so a head can move between calls) and appends every argv to a log (so the test can say exactly which `gh` calls
 * wrote), and the "agents", which are this test writing `out-<name>.json` files exactly as a dispatched agent would.
 *
 * Fixtures live under ~/.omp/pr-review-speedup/znd1/fixtures (never /tmp), and are removed afterwards.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const { execute, main, buildDeps } = require('../lib/review-run-cli');
const { defaultDeps: prepareGit } = require('../lib/review-prepare-runtime');
const { prepareReview } = require('../lib/pr-review-prepare');

const CLI = path.join(__dirname, '..', 'lib', 'review-run-cli.js');
const FIXTURES = path.join(os.homedir(), '.omp', 'pr-review-speedup', 'znd1', 'fixtures');
const BODY = '## Testing\nran the relevant tests\n\n## Risk\nlow\n\n## How to revert\nrevert the commit\n';
const POLICY = '# Review\n\n```ensemble-review-policy\n{"sensitivePaths":["secure/**"]}\n```\n';

const GH_STUB = `#!/usr/bin/env node
const fs = require('fs');
const cp = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.STUB_GH_STATE, 'utf8'));
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const fail = (stderr, stdout) => { process.stderr.write(stderr); if (stdout) process.stdout.write(stdout); process.exit(1); };
const joined = args.join(' ');
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = { headRefOid: state.head, baseRefName: 'main', state: state.prState || 'OPEN', body: state.body, author: { login: 'alice' }, isCrossRepository: state.isCrossRepository === undefined ? false : state.isCrossRepository };
  if (state.isCrossRepository === 'omit') delete pr.isCrossRepository;
  out(pr);
}
if (args[0] !== 'api') fail('unexpected gh call: ' + joined);
if (args[1] === 'user') out({ login: 'maintainer' });
if (/\\/pulls\\/\\d+\\/reviews/.test(joined)) out([state.reviews || []]);
if (/\\/git\\/commits\\/[0-9a-f]{40}$/.test(joined)) {
  const sha = args[args.length - 1].split('/').pop();
  out({ tree: { sha: cp.execFileSync('git', ['rev-parse', sha + '^{tree}'], { encoding: 'utf8' }).trim() } });
}
if (/\\/branches\\/main\\/protection/.test(joined)) fail('gh: Not Found (HTTP 404)', JSON.stringify({ message: 'Branch not protected' }));
if (/\\/commits\\/[0-9a-f]{40}\\/statuses/.test(joined)) out([[]]);
if (/\\/issues\\/\\d+\\/comments/.test(joined)) {
  if (args.includes('-X')) out({ id: 99, html_url: 'https://example.invalid/c/99' });
  out([[]]);
}
fail('unexpected gh call: ' + joined);
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
  const root = fs.mkdtempSync(path.join(FIXTURES, 'e2e-'));
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
  write(work, 'src/a.js', 'module.exports = (list) => list.map((x) => x + 1);\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'high');
  write(work, 'secure/key.js', 'module.exports = "k";\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'touch a sensitive path');
  git(work, 'checkout', '-q', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  write(work, 'src/a.js', 'module.exports = (list) => list.map((x, i) => list[i + 1] + x);\n');
  write(work, 'src/b.js', 'module.exports = () => 1;\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'feature');
  // a head whose own test file writes a marker outside the repository: proof that its code ran (or did not)
  const marker = path.join(root, 'MARKER');
  git(work, 'checkout', '-q', '-b', 'exec');
  write(work, 'src/b.test.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'the head code ran');\n`);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'a test that records that it ran');
  git(work, 'checkout', '-q', 'feature');
  // the review state is gitignored in real repositories; the fixture does the same so `git status` can be exact
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.ensemble/\n');
  return { root, origin, work, bin, marker, head: git(work, 'rev-parse', 'feature'), high: git(work, 'rev-parse', 'high'), exec: git(work, 'rev-parse', 'exec'), stateFile: path.join(root, 'gh-state.json'), logFile: path.join(root, 'gh.log') };
}

beforeAll(() => {
  fx = buildFixture();
});
afterAll(() => {
  // prepare seals the snapshot read-only; make it removable first
  spawnSync('chmod', ['-R', 'u+w', fx.root]);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

const setGh = (over = {}) => fs.writeFileSync(fx.stateFile, JSON.stringify({ head: fx.head, body: BODY, reviews: [], ...over }));
beforeEach(() => {
  setGh();
  fs.writeFileSync(fx.logFile, '');
});

const cliEnv = () => ({ ...process.env, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, STUB_GH_STATE: fx.stateFile, STUB_GH_LOG: fx.logFile, GIT_CONFIG_GLOBAL: '/dev/null' });

/** Runs the real CLI process: `{code, out}` with stdout parsed as the one JSON object. */
function cli(command, payload, { raw } = {}) {
  const r = spawnSync(process.execPath, [CLI, command], { input: raw === undefined ? JSON.stringify(payload) : raw, env: cliEnv(), encoding: 'utf8', cwd: fx.root });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch (error) {
    out = { unparsable: r.stdout, stderr: r.stderr, parseError: error.message };
  }
  return { code: r.status, out, stderr: r.stderr, stdout: r.stdout };
}

const prep = (extra = {}) => cli('prepare', { repo: 'o/r', pr: 7, repoRoot: fx.work, agentAuthored: false, ...extra });
const coll = (runId, extra = {}) => cli('collect', { repoRoot: fx.work, runId, ...extra });
const ghLog = () => fs.readFileSync(fx.logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const runDir = (runId) => path.join(fx.work, '.ensemble', 'pr-review', 'run', runId);

const writeResult = (agent, object) => {
  fs.mkdirSync(path.dirname(agent.outPath), { recursive: true });
  const temp = `${agent.outPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(object));
  fs.renameSync(temp, agent.outPath);
};
const reviewerFinding = (over = {}) => ({ locationOrLink: 'src/a.js:1', severity: 'important', failureMode: 'list[i + 1] reads one past the end on the last element', disposition: 'fix', evidence: 'src/a.js line 1 indexes list[list.length]', originalTextOrLink: 'src/a.js:1', ...over });

/** Answers a review manifest as real agents would: every reviewer covers its paths, the lane covers every changed path. */
function answerReview(manifest, { findings = {}, skip = [] } = {}) {
  const changed = ['src/a.js', 'src/b.js'];
  for (const agent of manifest.agents) {
    if (skip.includes(agent.name)) continue;
    if (agent.role === 'reviewer') writeResult(agent, { findings: findings[agent.name] || [], pathsReviewed: agent.paths });
    else writeResult(agent, { findings: findings[agent.name] || [], pathsReviewed: changed });
  }
}
const answerVotes = (manifest, verdict = 'real') => {
  for (const agent of manifest.agents) writeResult(agent, { votes: agent.candidateIds.map((id) => ({ candidateId: id, verdict, evidence: 'read it' })) });
};

const snapshotRepo = () => ({
  status: git(fx.work, 'status', '--porcelain'),
  head: git(fx.work, 'rev-parse', 'HEAD'),
  branch: git(fx.work, 'rev-parse', '--abbrev-ref', 'HEAD'),
  refs: git(fx.work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
  originRefs: git(fx.root, '--git-dir', fx.origin, 'for-each-ref', '--format=%(refname) %(objectname)'),
  tracked: git(fx.work, 'ls-files', '-s'),
});

describe('the real CLI process on a real git fixture', () => {
  test('prepare: one JSON object, exit 0, a DISPATCH manifest over a real snapshot and diff', () => {
    const r = prep({ runId: 'smoke' });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const m = r.out;
    expect(m).toMatchObject({ ok: true, status: 'DISPATCH', runId: 'smoke', round: 'review', wave: '1 of 1', headSha: fx.head, prState: 'OPEN' });
    expect(m.mode).toMatchObject({ mode: 'light' });
    expect(m.tier).toMatchObject({ tier: 'medium', effectiveTier: 'medium' });
    expect(m.agents.map((a) => a.name)).toEqual(['reviewer-s1-a', 'reviewer-s1-b', 'security-lane']);
    expect(m.precheck).toMatchObject({ comment: { action: 'created', id: 99 } });
    // the diff and the snapshot the briefs name are the real prepared ones
    const brief = fs.readFileSync(m.agents[0].briefPath, 'utf8');
    const diffPath = /Diff for your slice: (\S+)/.exec(brief)[1];
    expect(fs.readFileSync(diffPath, 'utf8')).toContain('src/b.js');
    const snapshot = /snapshot of the reviewed commit: (\S+)/.exec(brief)[1];
    expect(fs.readFileSync(path.join(snapshot, 'src', 'b.js'), 'utf8')).toBe('module.exports = () => 1;\n');
    expect(brief).toMatch(/- src\/a\.js\n- src\/b\.js/);
    process.stderr.write(`\nSMOKE manifest: ${JSON.stringify({ status: m.status, runId: m.runId, round: m.round, wave: m.wave, tier: m.tier.effectiveTier, depth: m.depth, agents: m.agents.map((a) => ({ name: a.name, role: a.role, outPath: path.relative(fx.work, a.outPath), deadlineAtIso: a.deadlineAtIso })) })}\n`);
  });

  test('prepare -> agents -> collect -> verify wave -> collect -> ADJUDICATE -> adjudicate -> DONE, with the repository untouched', () => {
    const before = snapshotRepo();
    const prepared = prep({ runId: 'flow' });
    expect(prepared.code).toBe(0);
    const review = prepared.out;

    // nothing has arrived yet: PENDING, exit 0
    const pending = coll('flow');
    expect(pending.code).toBe(0);
    expect(pending.out).toMatchObject({ status: 'PENDING', round: 'review' });
    expect(pending.out.waitingOn.sort()).toEqual(['reviewer-s1-a', 'reviewer-s1-b', 'security-lane']);

    answerReview(review, { findings: { 'reviewer-s1-a': [reviewerFinding({ uncertain: true })] } });
    const verify = coll('flow');
    expect(verify.code).toBe(0);
    expect(verify.out).toMatchObject({ ok: true, status: 'DISPATCH', round: 'verify', wave: '1 of 1' });
    expect(verify.out.agents).toHaveLength(3);
    expect(verify.out.agents.every((a) => a.role === 'verifier' && a.candidateIds.join() === 'f1')).toBe(true);
    const verifierBrief = fs.readFileSync(verify.out.agents[0].briefPath, 'utf8');
    expect(verifierBrief).toContain('list[i + 1] reads one past the end');
    expect(verifierBrief).not.toContain('reviewer-s1');
    expect(verifierBrief).not.toContain('line 1 indexes');

    answerVotes(verify.out, 'real');
    const adjudicate = coll('flow');
    expect(adjudicate.code).toBe(0);
    expect(adjudicate.out).toMatchObject({ ok: true, status: 'ADJUDICATE' });
    expect(adjudicate.out.adjudicate).toEqual([{ id: 'f1', why: expect.stringContaining('uncertain') }]);
    expect(adjudicate.out.votes).toMatchObject({ verification: 'performed' });
    expect(adjudicate.out.security.status).toBe('clean');
    expect(adjudicate.out.coverage).toEqual({ complete: true, unreviewedSlices: [], uncovered: [] });
    expect(adjudicate.out.gate.mergeable).toBe(false);
    expect(adjudicate.out.gate.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['open-important-finding', 'approvals-unsatisfied']));
    expect(adjudicate.out.reviewStatus.status).not.toBe('REVIEW_COMPLETE');
    expect(adjudicate.out.metrics).toMatchObject({ runnerCalls: 4, dispatchRounds: 2, agentsDispatched: 6 });

    // the state report and final.json are on disk
    const statePath = path.join(fx.work, '.ensemble', 'pr-review', 'pr-7.json');
    expect(adjudicate.out.statePath).toBe(statePath);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state).toMatchObject({ prId: 7, runId: 'flow', reviewedHeadSha: fx.head, mode: 'light' });
    expect(state.ledger).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(runDir('flow'), 'final.json'), 'utf8')).status).toBe('ADJUDICATE');

    // idempotent re-entry
    expect(coll('flow').out).toEqual(adjudicate.out);

    // adjudicate: deferral of an Important finding does not unblock the gate
    const done = coll('flow', { adjudications: [{ id: 'f1', disposition: 'deferred', reason: 'tracked as a follow-up' }] });
    expect(done.code).toBe(0);
    expect(done.out).toMatchObject({ status: 'DONE', adjudicatedBy: 'orchestrator' });
    expect(done.out.gate.mergeable).toBe(false);
    expect(done.out.gate.findings.open).toEqual(['f1']);
    expect(coll('flow').out).toEqual(done.out);

    // AC3: no push, no checkout, no change to the tree or any ref, and the only gh write is the precheck's comment
    expect(snapshotRepo()).toEqual(before);
    const writes = ghLog().filter((a) => a.includes('-X'));
    expect(writes).toEqual([['api', '-X', 'POST', 'repos/o/r/issues/7/comments', '-f', expect.stringContaining('ensemble:pr-review-precheck')]]);
    expect(ghLog().some((a) => ['merge', 'close', 'edit', 'review', 'checkout'].includes(a[1]))).toBe(false);
    // the run directory is private
    expect(fs.statSync(runDir('flow')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(runDir('flow'), 'run.json')).mode & 0o777).toBe(0o600);
  });

  test('a run with no uncertain finding and every vote cast finishes DONE in one collect after the verify wave', () => {
    const review = prep({ runId: 'plain' }).out;
    answerReview(review, { findings: { 'reviewer-s1-b': [reviewerFinding({ locationOrLink: 'src/b.js:1', failureMode: 'the exported function ignores its arguments entirely' })] } });
    const verify = coll('plain').out;
    answerVotes(verify, 'not-real');
    const done = coll('plain');
    expect(done.code).toBe(0);
    expect(done.out.status).toBe('DONE');
    expect(done.out.ledger[0].verification).toMatchObject({ outcome: 'filtered', authorLabel: 'verifier disagrees' });
    expect(done.out.gate.findings.open).toEqual(['f1']); // filtered, still listed and still blocking
  });

  test('a High path is NEEDS_FULL_MODE: exit 1, nothing dispatched, no briefs, later calls repeat it', () => {
    setGh({ head: fx.high });
    const r = prep({ runId: 'high' });
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, status: 'NEEDS_FULL_MODE', dispatched: [] });
    expect(r.out.reason).toMatch(/sensitive-path/);
    expect(r.out.mode.mode).toBe('full');
    expect(fs.existsSync(path.join(runDir('high'), 'briefs'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(runDir('high'), 'run.json'), 'utf8')).phase).toBe('needs-full-mode');
    const again = coll('high');
    expect(again.code).toBe(1);
    expect(again.out).toMatchObject({ status: 'NEEDS_FULL_MODE' });
  });

  test('a head that moves between prepare and collect is RUN_INVALIDATED: exit 1, no ledger, no gate, no state report', () => {
    fs.rmSync(path.join(fx.work, '.ensemble', 'pr-review', 'pr-7.json'), { force: true });
    const review = prep({ runId: 'moved' }).out;
    answerReview(review);
    setGh({ head: 'd'.repeat(40) });
    const r = coll('moved');
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, status: 'RUN_INVALIDATED', reason: 'head-moved', expectedHead: fx.head, currentHead: 'd'.repeat(40) });
    expect(fs.existsSync(path.join(runDir('moved'), 'final.json'))).toBe(false);
    expect(fs.existsSync(path.join(fx.work, '.ensemble', 'pr-review', 'pr-7.json'))).toBe(false);
    setGh();
    expect(coll('moved').out.status).toBe('RUN_INVALIDATED');
  });

  test('a reviewer that never arrives: after its deadline the run is DONE with the slice NOT reviewed', () => {
    const review = prep({ runId: 'late' }).out;
    answerReview(review, { skip: ['reviewer-s1-b'] });
    const r = coll('late', { now: review.agents[1].deadlineAt + 60000 });
    expect(r.code).toBe(0);
    expect(r.out.status).toBe('DONE');
    expect(r.out.notReviewed.unreviewedSlices).toEqual(['whole-pr']);
    expect(r.out.notReviewed.expiredAgents.map((a) => a.name)).toEqual(['reviewer-s1-b']);
    expect(r.out.coverage.complete).toBe(false);
  });

  test('the process boundary rejects bad input as {ok:false} with exit 1', () => {
    expect(cli('nonsense', {})).toMatchObject({ code: 1, out: { ok: false, error: expect.stringContaining('unknown subcommand') } });
    expect(cli('prepare', null, { raw: 'not json' })).toMatchObject({ code: 1, out: { ok: false, error: expect.stringContaining('cannot read the payload') } });
    expect(cli('prepare', null, { raw: '' })).toMatchObject({ code: 1, out: { ok: false } });
    expect(prep({ dryrun: true })).toMatchObject({ code: 1, out: { ok: false, status: 'RUN_FAILED', reason: 'invalid-input' } });
    expect(cli('prepare', [1, 2])).toMatchObject({ code: 1, out: { ok: false, reason: 'invalid-input' } });
    expect(coll('does-not-exist')).toMatchObject({ code: 1, out: { ok: false, reason: 'run-not-found' } });
    expect(cli('collect', { repoRoot: fx.work, runId: 'x', stray: 1 })).toMatchObject({ code: 1, out: { reason: 'invalid-input' } });
  });

  test('output is redacted: a token-shaped string in a finding never reaches stdout or the files', () => {
    const secret = `ghp_${'A'.repeat(30)}`;
    const review = prep({ runId: 'secret' }).out;
    answerReview(review, { findings: { 'reviewer-s1-a': [reviewerFinding({ evidence: `the token ${secret} is logged`, uncertain: true })] } });
    const verify = coll('secret').out;
    answerVotes(verify);
    const r = coll('secret');
    expect(r.stdout).not.toContain(secret);
    expect(fs.readFileSync(path.join(runDir('secret'), 'final.json'), 'utf8')).not.toContain(secret);
    expect(fs.readFileSync(path.join(runDir('secret'), 'run.json'), 'utf8')).not.toContain(secret);
  });
});

describe('a head from outside this repository is never run (review of PR 264, P0)', () => {
  // `node` runs each related test file as a script: the head's own code, exactly what the baseline executes.
  const withNode = { testCommand: [process.execPath] };
  beforeEach(() => fs.rmSync(fx.marker, { force: true }));

  test('control: a same-repository head is prepared and its baseline runs the head\'s own test code', () => {
    setGh({ head: fx.exec });
    const r = prep({ runId: 'exec-control', ...withNode });
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, status: 'DISPATCH' });
    expect(fs.readFileSync(fx.marker, 'utf8')).toBe('the head code ran');
  });

  test.each([
    ['a fork head', true, 'cross-repository-head'],
    ['a head whose repository GitHub did not state', 'omit', 'head-repository-unknown'],
  ])('%s is refused by name: its code never runs, nothing is fetched, prepared or posted', (_label, isCrossRepository, reason) => {
    setGh({ head: fx.exec, isCrossRepository });
    const runId = `refused-${reason}`;
    const r = prep({ runId, ...withNode });
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason, headSha: fx.exec });
    expect(fs.existsSync(fx.marker)).toBe(false);
    expect(fs.existsSync(runDir(runId))).toBe(false);
    expect(fs.existsSync(path.join(fx.work, '.ensemble', 'pr-review', 'prepare', runId))).toBe(false);
    // the one read of the PR is the only host call: no precheck comment, no gate, no reviews read
    const calls = ghLog();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((a) => a[0] === 'pr' && a[1] === 'view')).toBe(true);
  });
});

describe('in-process: every process the runner starts is recorded', () => {
  const FORBIDDEN_GIT = /^(push|checkout|switch|reset|stash|commit|add|rebase|apply|merge|cherry-pick|revert|clean|rm|mv|restore|pull|tag|branch|update-ref|worktree|am|gc|prune)$/;

  test('no git call of a whole run (runner, precheck and prepare) edits, resets or pushes; the only gh write is the precheck comment', async () => {
    const calls = [];
    const real = require('../lib/review-run-cli').defaultRun;
    const run = async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      return real(cmd, args, opts);
    };
    const gitRecorded = (args, opts) => {
      calls.push(['git(prepare)', ...args]);
      return prepareGit().git(args, opts);
    };
    const injected = {
      run,
      prepareReview: (options) => prepareReview(options, { git: gitRecorded }),
    };
    const old = process.env;
    process.env = cliEnv();
    try {
      const payloads = [];
      const exec = async (command, payload) => {
        payloads.push(command);
        return execute(command, { ...injected, readJson: () => payload });
      };
      const p = await exec('prepare', { repo: 'o/r', pr: 7, repoRoot: fx.work, runId: 'inproc', agentAuthored: false });
      expect(p.code).toBe(0);
      answerReview(p.result, { findings: { 'reviewer-s1-a': [reviewerFinding()] } });
      const v = await exec('collect', { repoRoot: fx.work, runId: 'inproc' });
      expect(v.result.status).toBe('DISPATCH');
      answerVotes(v.result);
      const d = await exec('collect', { repoRoot: fx.work, runId: 'inproc' });
      expect(d.result.status).toBe('DONE');
    } finally {
      process.env = old;
    }
    const gits = calls.filter((c) => c[0] === 'git' || c[0] === 'git(prepare)');
    expect(gits.length).toBeGreaterThan(5);
    for (const c of gits) {
      expect(c[1]).not.toMatch(FORBIDDEN_GIT);
      if (c[1] === 'archive') expect(c).toEqual(expect.arrayContaining(['--format=tar', '-o']));
    }
    const ghWrites = calls.filter((c) => c[0] === 'gh' && c.includes('-X'));
    expect(ghWrites).toHaveLength(1);
    expect(ghWrites[0].slice(0, 4)).toEqual(['gh', 'api', '-X', 'POST']);
    expect(calls.filter((c) => c[0] === 'gh').every((c) => c[1] === 'api' || (c[1] === 'pr' && c[2] === 'view'))).toBe(true);
  });

  test('main() prints one redacted JSON line and returns the exit code', async () => {
    let text = '';
    const code = await main(['prepare'], { readJson: () => ({ repo: 'o/r', pr: 7, repoRoot: 'relative/path', runId: 'x' }) }, (t) => { text += t; });
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(buildDeps({ repo: 'o/r', pr: 1, repoRoot: fx.work }, {}).notices).toEqual([]);
  });
});
