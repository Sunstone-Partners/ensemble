'use strict';

/**
 * A re-review of the next head through the real review-run CLI (kata xb4j): the runner plans a delta, carries what the push
 * left alone and verifies the rest, and reads the whole range whenever the last round is not on record.
 *
 * Real: git (an origin, a clone, a 19-file Medium PR, a fix push, a force-push), the CLI process (prepare and collect), prepare
 * (snapshot, diffs, facts, delta plan, import graph), the carry hash, the fixed-finding check, the state report and the run
 * files. Faked: `gh` (an executable stub first on PATH, answering from a JSON file the test edits) and the agents, which are
 * this test writing `out-<name>.json` files exactly as a dispatched agent would.
 *
 * Fixtures live under ~/.omp/pr-review-speedup/xb4j/fixtures (never /tmp) and are removed afterwards.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'lib', 'review-run-cli.js');
const FIXTURES = path.join(os.homedir(), '.omp', 'pr-review-speedup', 'xb4j', 'fixtures');
const BODY = '## Testing\nran the relevant tests\n\n## Risk\nlow\n\n## How to revert\nrevert the commit\n';
const POLICY = '# Review\n\n```ensemble-review-policy\n{"sensitivePaths":["secure/**"],"highPaths":["wide/**"]}\n```\n';
/** The changed lines of the 19 paths of the Medium PR (the shape of the one real run): three slices, a whole-range reader and the lane. */
const LINES = [1, 127, 1, 159, 1, 145, 12, 8, 76, 125, 355, 38, 1, 8, 76, 159, 1, 145, 12];
const medPath = (index) => `med/a${String(index + 1).padStart(2, '0')}.js`;
const ALL_PATHS = LINES.map((_, index) => medPath(index));
const body = (count) => `${Array.from({ length: count }, (_, line) => `// line ${line + 1}`).join('\n')}\n`;

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

/** origin + clone; `main` holds the policy; `head1` is the 19-file Medium PR; branches for each follow-up head are made by the tests. */
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
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'pr');
  LINES.forEach((count, index) => write(work, medPath(index), body(count)));
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'a wide Medium PR');
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.ensemble/\n');
  return { root, origin, work, bin, head1: git(work, 'rev-parse', 'HEAD'), stateFile: path.join(root, 'gh-state.json'), logFile: path.join(root, 'gh.log') };
}

beforeAll(() => {
  fx = buildFixture();
});

afterAll(() => {
  spawnSync('chmod', ['-R', 'u+w', fx.root]);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

const setGh = (over = {}) => fs.writeFileSync(fx.stateFile, JSON.stringify({ head: fx.head1, body: BODY, reviews: [], ...over }));
beforeEach(() => {
  setGh();
  fs.writeFileSync(fx.logFile, '');
});

const cliEnv = () => ({ ...process.env, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, STUB_GH_STATE: fx.stateFile, STUB_GH_LOG: fx.logFile, GIT_CONFIG_GLOBAL: '/dev/null' });

/** Runs the real CLI process: `{code, out}` with stdout parsed as the one JSON object. */
function cli(command, payload) {
  const r = spawnSync(process.execPath, [CLI, command], { input: JSON.stringify(payload), env: cliEnv(), encoding: 'utf8', cwd: fx.root, timeout: 180000 });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch (error) {
    out = { unparsable: r.stdout, stderr: r.stderr, error: r.error && r.error.message };
  }
  return { code: r.status, out };
}
const prep = (runId, extra = {}) => cli('prepare', { repo: 'o/r', pr: 7, repoRoot: fx.work, runId, agentAuthored: false, ...extra });
const coll = (runId, extra = {}) => cli('collect', { repoRoot: fx.work, runId, ...extra });
const statePath = () => path.join(fx.work, '.ensemble', 'pr-review', 'pr-7.json');
const readStateFile = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const runFile = (runId) => JSON.parse(fs.readFileSync(path.join(fx.work, '.ensemble', 'pr-review', 'run', runId, 'run.json'), 'utf8'));

const writeResult = (agent, object) => {
  fs.mkdirSync(path.dirname(agent.outPath), { recursive: true });
  const temp = `${agent.outPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(object));
  fs.renameSync(temp, agent.outPath);
};
const finding = (location, mode) => ({ locationOrLink: location, severity: 'important', failureMode: mode, disposition: 'fix', evidence: `${location} says so` });

/** Stand-in agents: every reviewer lists the paths of its slice, the reader and the lane list every path they were given. */
function answerReview(manifest, { findings = {}, skip = [], lanePaths = ALL_PATHS } = {}) {
  for (const agent of manifest.agents) {
    if (skip.includes(agent.name)) continue;
    writeResult(agent, { findings: findings[agent.name] || [], pathsReviewed: agent.paths || lanePaths });
  }
}
const answerVotes = (manifest, verdict = 'real') => {
  for (const agent of manifest.agents) writeResult(agent, { votes: agent.candidateIds.map((id) => ({ candidateId: id, verdict, evidence: 'read it' })) });
};

/** Round one on `fx.head1`: two settled findings (med/a02.js:5 and med/a03.js:1), both confirmed by every verifier. */
function firstRound(runId) {
  setGh({ head: fx.head1 });
  fs.rmSync(statePath(), { force: true });
  const p = prep(runId);
  expect(p.code).toBe(0);
  expect(p.out).toMatchObject({ status: 'DISPATCH', mode: { mode: 'light' } });
  answerReview(p.out, {
    findings: {
      'reviewer-s1-a': [finding('med/a02.js:5', 'the loop on line 5 reads one past the end of the list')],
      'reviewer-s2-a': [finding('med/a03.js:1', 'the first line returns before the guard on line 2 can run')],
    },
  });
  const v = coll(runId);
  expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify' });
  answerVotes(v.out);
  const done = coll(runId);
  expect(done.out).toMatchObject({ ok: true, status: 'DONE', reviewStatus: { reviewedHeadSha: fx.head1 } });
  return { prepare: p.out, verify: v.out, done: done.out };
}

/** A fix push: a new commit on top of `parent` that edits `edits` ({path: text}); returns its sha and makes it the PR's head. */
function push(parent, edits, name) {
  git(fx.work, 'checkout', '-q', '-B', name, parent);
  for (const [file, text] of Object.entries(edits)) write(fx.work, file, text);
  git(fx.work, 'add', '.');
  git(fx.work, 'commit', '-q', '-m', `fix push ${name}`);
  const sha = git(fx.work, 'rev-parse', 'HEAD');
  setGh({ head: sha });
  return sha;
}
const edited = (index, change) => `${body(LINES[index]).replace('// line 5\n', `// line 5 ${change}\n`)}`;

const F1 = ['med/a02.js:5', 'the loop on line 5 reads one past the end of the list'];
const F2 = ['med/a03.js:1', 'the first line returns before the guard on line 2 can run'];

describe('a re-review of the next head through the real CLI (kata xb4j)', () => {
  test('first round records the verdicts the next round can carry: each settled finding bound to the hash of its cited hunk at the reviewed head', () => {
    const first = firstRound('r1');
    expect(first.prepare.agents).toHaveLength(8);
    expect(first.prepare.reReview).toBeUndefined();
    expect(first.verify.agents.flatMap((a) => a.candidateIds)).toHaveLength(6);
    const state = readStateFile();
    expect(state.carry).toMatchObject({ appliedRange: 'full-range', carried: 0, recorded: 2, skipped: [] });
    expect(state.verdicts).toHaveLength(2);
    for (const verdict of state.verdicts) {
      expect(verdict).toMatchObject({ head: fx.head1, outcome: 'present', prId: '7', baseSha: expect.stringMatching(/^[0-9a-f]{40}$/), depth: 'standard', expectedVerifiers: 3 });
      expect(verdict.hunkHash).toMatch(/^[0-9a-f]{64}$/);
      expect(verdict.votes).toHaveLength(3);
    }
    expect(state.verdicts.map((v) => v.file).sort()).toEqual(['med/a02.js', 'med/a03.js']);
  });

  test('a fix push: the re-review plans a delta (fewer agents), carries the verdict the push left alone and verifies only what changed', () => {
    firstRound('b1');
    const stateBefore = readStateFile();
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'fix1');
    const p = prep('b2', { lastReviewedSha: fx.head1, remediationShas: [head2] });
    expect(p.code).toBe(0);
    // the plan: the delta, read by one slice (two reviewers and the lane) instead of the 8 agents of a full re-read
    expect(p.out).toMatchObject({ status: 'DISPATCH', headSha: head2, mode: { mode: 'light' } });
    expect(p.out.reReview).toMatchObject({ scope: 'delta', appliedRange: 'delta', delta: { lastReviewedSha: fx.head1, changedPaths: 1, readPaths: 1, agentsPlanned: 3, agentsFullRead: 8 } });
    expect(p.out.agents.map((a) => a.name)).toEqual(['reviewer-s1-a', 'reviewer-s1-b', 'security-lane']);
    expect(p.out.sizing.work.files).toBe(1);
    // the reviewers read the DELTA diff, not the whole range
    const brief = fs.readFileSync(p.out.agents[0].briefPath, 'utf8');
    const diffPath = /Diff for your slice: (\S+)/.exec(brief)[1];
    expect(path.basename(diffPath)).toBe('delta.diff');
    expect(fs.readFileSync(diffPath, 'utf8')).toContain('diff --git a/med/a02.js b/med/a02.js');
    expect(fs.readFileSync(diffPath, 'utf8')).not.toContain('med/a03.js');
    // the reviewers raise the same two defects again: the first on a line the push changed, the second on code it did not touch
    answerReview(p.out, { lanePaths: ['med/a02.js'], findings: { 'reviewer-s1-a': [finding(...F1), finding(...F2)] } });
    const v = coll('b2');
    expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify', carry: { carried: 1, verified: 1 } });
    // only the changed one goes to verifiers
    const asked = v.out.agents.flatMap((a) => a.candidateIds);
    expect(asked).toHaveLength(3);
    expect(new Set(asked).size).toBe(1);
    answerVotes(v.out);
    const done = coll('b2');
    expect(done.out).toMatchObject({ ok: true, status: 'DONE', carry: { appliedRange: 'delta', carried: 1, reverified: 1, readPaths: 1 } });
    expect(done.out.reReview.appliedRange).toBe('delta');
    // the ledger: the carried finding is the PRIOR entry restamped with this head, the changed one is a fresh entry, the prior entry the
    // fresh one replaces is gone, and no two share an id
    const ids = done.out.ledger.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(done.out.ledger).toHaveLength(2);
    const carried = done.out.ledger.find((entry) => entry.locationOrLink === F2[0]);
    const priorF2 = stateBefore.ledger.find((entry) => entry.locationOrLink === F2[0]);
    expect(carried).toMatchObject({ id: priorF2.id, headSha: head2, carriedFrom: fx.head1, verification: { outcome: 'present' } });
    const changed = done.out.ledger.find((entry) => entry.locationOrLink === F1[0]);
    expect(changed.id).not.toBe(stateBefore.ledger.find((entry) => entry.locationOrLink === F1[0]).id);
    expect(changed.verification).toMatchObject({ outcome: 'present', reason: 'verifier-majority' });
    expect(done.out.votes.outcomes.map((o) => o.outcome)).toEqual(expect.arrayContaining(['present']));
    expect(done.out.coverage).toEqual({ complete: true, unreviewedSlices: [], uncovered: [] });
    // what the next round may carry: the carried record (restamped) and the new one
    const state = readStateFile();
    expect(state.verdicts.map((v) => [v.file, v.head, v.carriedFrom || null]).sort()).toEqual([['med/a02.js', head2, null], ['med/a03.js', head2, fx.head1]]);
    expect(state.carry).toMatchObject({ appliedRange: 'delta', carried: 1 });
    // the run file records the same plan
    expect(runFile('b2').reReview).toMatchObject({ scope: 'delta', appliedRange: 'delta' });
  });
});

/** Round one, a fix push that edits one line of med/a02.js, and the re-review's prepare, with the prefix naming the runs. */
function secondPrepare(prefix, { extra = {}, edits = { 'med/a02.js': edited(1, 'FIXED') }, parent } = {}) {
  firstRound(`${prefix}1`);
  const head2 = push(parent || fx.head1, edits, `${prefix}-fix`);
  return { head2, p: prep(`${prefix}2`, { lastReviewedSha: fx.head1, remediationShas: [head2], ...extra }) };
}

/** A prepare answer that read the whole range: the reasons it says so, the 8 agents of a full read, no delta plan. */
function expectFullRead(answer, reasons) {
  expect(answer.code).toBe(0);
  expect(answer.out).toMatchObject({ status: 'DISPATCH' });
  expect(answer.out.reReview).toMatchObject({ scope: 'full', appliedRange: 'full-range', reasons: expect.arrayContaining(reasons) });
  expect(answer.out.reReview.delta).toBeUndefined();
  expect(answer.out.agents).toHaveLength(8);
  expect(answer.out.sizing.work.files).toBe(19);
}

describe('every re-review the runner cannot stand behind reads the whole range (fail closed)', () => {
  test('no state report of the last round: head-never-seen, a full read, never a silent skip', () => {
    firstRound('c1');
    fs.rmSync(statePath());
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'c-fix');
    expectFullRead(prep('c2', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['head-never-seen', 'prior-round-unusable:state-absent']);
  });

  test('a head the state did not record (the caller names an ancestor nobody reviewed): a full read', () => {
    firstRound('d1');
    const mid = push(fx.head1, { 'med/a05.js': `${body(LINES[4])}// extra\n` }, 'd-mid');
    const head3 = push(mid, { 'med/a02.js': edited(1, 'FIXED') }, 'd-fix');
    expectFullRead(prep('d2', { lastReviewedSha: mid, remediationShas: [head3] }), ['head-never-seen', 'prior-round-unusable:state-other-head']);
  });

  test('a force-pushed head that no longer descends from the reviewed one: a full read', () => {
    firstRound('e1');
    git(fx.work, 'checkout', '-q', '-B', 'e-force', 'main');
    LINES.forEach((count, index) => write(fx.work, medPath(index), `${body(count)}// rewritten\n`));
    git(fx.work, 'add', '.');
    git(fx.work, 'commit', '-q', '-m', 'force-pushed replacement');
    const forced = git(fx.work, 'rev-parse', 'HEAD');
    setGh({ head: forced });
    expectFullRead(prep('e2', { lastReviewedSha: fx.head1, remediationShas: [forced] }), ['range-is-full']);
  });

  test('a last head this repository does not hold: never a delta', () => {
    firstRound('f1');
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'f-fix');
    const unknown = '1'.repeat(40);
    const r = prep('f2', { lastReviewedSha: unknown, remediationShas: [head2] });
    // either refused outright or read whole: never narrowed to a delta against a head nobody can place
    if (r.out.status === 'DISPATCH') expectFullRead(r, ['range-is-full', 'commit-facts-unavailable']);
    else expect(r.out).toMatchObject({ ok: false });
  });

  test('a last round that left something unread (a skipped reviewer): the delta cannot stand for the rest of the PR, a full read', () => {
    setGh({ head: fx.head1 });
    fs.rmSync(statePath(), { force: true });
    const p = prep('g1');
    answerReview(p.out, { skip: ['reviewer-s1-b'] });
    // the skipped reviewer's deadline passes: it is reported not reviewed and the round still ends
    const done = coll('g1', { now: Date.now() + 2 * 3600 * 1000 });
    expect(done.out).toMatchObject({ status: 'DONE' });
    expect(readStateFile().notReviewed.expiredAgents.length + readStateFile().notReviewed.unreviewedSlices.length).toBeGreaterThan(0);
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'g-fix');
    expectFullRead(prep('g2', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['prior-round-unusable:state-round-incomplete']);
  });

  test('a state report with no recorded verdicts (written by anything but this runner): a full read', () => {
    firstRound('h1');
    const state = readStateFile();
    delete state.verdicts;
    fs.writeFileSync(statePath(), JSON.stringify(state));
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'h-fix');
    expectFullRead(prep('h2', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['prior-round-unusable:state-verdicts-unrecorded']);
  });

  test('a state report that says it reviewed another head than the one it was written for: a full read', () => {
    firstRound('q1');
    const state = readStateFile();
    state.reviewedHeadSha = '3'.repeat(40);
    fs.writeFileSync(statePath(), JSON.stringify(state));
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'q-fix');
    expectFullRead(prep('q2', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['prior-round-unusable:state-other-head']);
  });

  test('a last round whose security lane raised a finding: the lane findings are not in the ledger, so the whole range is read again', () => {
    setGh({ head: fx.head1 });
    fs.rmSync(statePath(), { force: true });
    const p = prep('r1s');
    answerReview(p.out, { findings: { 'security-lane': [finding('med/a02.js:5', 'a secret read from the environment is written to the log')] } });
    expect(coll('r1s').out).toMatchObject({ status: 'DONE', security: { status: 'findings' } });
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'r-fix');
    expectFullRead(prep('r2s', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['prior-round-unusable:state-security-open']);
  });

  test('a state report whose run record is gone or says another head: a full read', () => {
    firstRound('i1');
    const record = path.join(fx.work, '.ensemble', 'pr-review', 'run', 'i1', 'run.json');
    const original = fs.readFileSync(record, 'utf8');
    fs.rmSync(record);
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'i-fix');
    expectFullRead(prep('i2', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['prior-round-unusable:state-run-record-mismatch']);
    fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(original), headSha: '2'.repeat(40) }));
    expectFullRead(prep('i3', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['prior-round-unusable:state-run-record-mismatch']);
  });

  test('a state report whose run id is not a plain run id never reads a file outside the run directory', () => {
    firstRound('j1');
    const state = readStateFile();
    state.runId = '../../../escape';
    fs.writeFileSync(statePath(), JSON.stringify(state));
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'j-fix');
    expectFullRead(prep('j2', { lastReviewedSha: fx.head1, remediationShas: [head2] }), ['prior-round-unusable:state-run-record-mismatch']);
  });

  test('the reviewed head and base are not payload keys: a caller cannot name what the last round reviewed', () => {
    firstRound('k1');
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'k-fix');
    for (const key of ['reviewedHeadSha', 'reviewedBaseSha']) {
      const r = prep(`k2${key}`, { lastReviewedSha: fx.head1, remediationShas: [head2], [key]: fx.head1 });
      expect(r.code).toBe(1);
      expect(r.out).toMatchObject({ ok: false, reason: 'invalid-input', error: expect.stringContaining(key) });
    }
  });

  test('a push that touches a sensitive path: the delta plan refuses, a full read', () => {
    firstRound('l1');
    const head2 = push(fx.head1, { 'secure/key.js': 'module.exports = "k";\n' }, 'l-fix');
    const r = prep('l2', { lastReviewedSha: fx.head1, remediationShas: [head2] });
    expect(r.code).toBe(0);
    expect(r.out.reReview).toMatchObject({ scope: 'full', appliedRange: 'full-range', reasons: expect.arrayContaining(['sensitive-path-touched']) });
    expect(r.out.reReview.delta).toBeUndefined();
  });

  test('a push whose commit the caller does not list as a remediation: unvouched history, a full read', () => {
    firstRound('m1');
    push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'm-fix');
    const r = prep('m2', { lastReviewedSha: fx.head1 });
    expectFullRead(r, ['unvouched-history']);
  });
});

describe('what a delta round does with the findings of the round before', () => {
  test('a finding in code the push fixed is cleared and one in code nobody re-read stays, still blocking (never dropped by the narrower read)', () => {
    firstRound('n1');
    const before = readStateFile().ledger;
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'n-fix');
    const p = prep('n2', { lastReviewedSha: fx.head1, remediationShas: [head2] });
    expect(p.out.reReview).toMatchObject({ scope: 'delta', appliedRange: 'delta' });
    answerReview(p.out, { lanePaths: ['med/a02.js'] });
    const done = coll('n2');
    expect(done.out).toMatchObject({ ok: true, status: 'DONE', carry: { appliedRange: 'delta', carried: 0, reverified: 0 } });
    const byLocation = (location) => done.out.ledger.find((entry) => entry.locationOrLink === location);
    expect(byLocation(F1[0])).toMatchObject({ id: before.find((e) => e.locationOrLink === F1[0]).id, cleared: true, clearedBy: head2 });
    expect(byLocation(F2[0]).cleared).toBeUndefined();
    expect(done.out.carry.cleared).toEqual([byLocation(F1[0]).id]);
    // the Important finding nobody re-read still blocks
    expect(done.out.gate.mergeable).toBe(false);
    expect(done.out.gate.blockers.map((b) => b.code)).toContain('open-important-finding');
  });

  test('a push that edits the cited line of BOTH findings: nothing is carried, both go to verifiers again', () => {
    firstRound('o1');
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED'), 'med/a03.js': '// line 1 changed\n' }, 'o-fix');
    const p = prep('o2', { lastReviewedSha: fx.head1, remediationShas: [head2] });
    expect(p.out.reReview).toMatchObject({ scope: 'delta', delta: { changedPaths: 2, readPaths: 2 } });
    answerReview(p.out, { lanePaths: ['med/a02.js', 'med/a03.js'], findings: { 'reviewer-s1-a': [finding(...F1), finding(...F2)] } });
    const v = coll('o2');
    expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify', carry: { carried: 0, verified: 2 } });
    expect(new Set(v.out.agents.flatMap((a) => a.candidateIds)).size).toBe(2);
    answerVotes(v.out);
    const done = coll('o2');
    expect(done.out).toMatchObject({ status: 'DONE', carry: { carried: 0, reverified: 2 } });
    expect(done.out.ledger).toHaveLength(2);
    expect(done.out.ledger.every((entry) => entry.carriedFrom === undefined)).toBe(true);
  });

  test('a verdict the push left alone stays carried through a SECOND fix push: the carry chains from round to round', () => {
    firstRound('p1');
    const head2 = push(fx.head1, { 'med/a02.js': edited(1, 'FIXED') }, 'p-fix1');
    const p2 = prep('p2', { lastReviewedSha: fx.head1, remediationShas: [head2] });
    answerReview(p2.out, { lanePaths: ['med/a02.js'], findings: { 'reviewer-s1-a': [finding(...F1), finding(...F2)] } });
    answerVotes(coll('p2').out);
    expect(coll('p2').out).toMatchObject({ status: 'DONE', carry: { carried: 1 } });
    // round three: another one-line push to a different file; the finding in med/a03.js is carried again, from the FIRST head
    const head3 = push(head2, { 'med/a05.js': `${body(LINES[4])}// extra\n` }, 'p-fix2');
    const p3 = prep('p3', { lastReviewedSha: head2, remediationShas: [head3] });
    expect(p3.out.reReview).toMatchObject({ scope: 'delta', delta: { lastReviewedSha: head2, changedPaths: 1 } });
    answerReview(p3.out, { lanePaths: ['med/a05.js'], findings: { 'reviewer-s1-a': [finding(...F2)] } });
    const done = coll('p3');
    expect(done.out).toMatchObject({ status: 'DONE', carry: { carried: 1, reverified: 0 } });
    expect(done.out.ledger.find((entry) => entry.locationOrLink === F2[0])).toMatchObject({ headSha: head3, carriedFrom: fx.head1 });
    expect(readStateFile().verdicts.find((v) => v.file === 'med/a03.js')).toMatchObject({ head: head3, carriedFrom: fx.head1 });
  });
});
