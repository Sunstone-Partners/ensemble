'use strict';

/**
 * Two follow-ups of the final PR-review speedup measurement, through the real review-run CLI.
 *
 * kata bh8w: a fix that only ADDS lines inside a cited range (`git diff -U0`: `@@ -104,0 +105,5 @@`) touches the finding it fixes, so the
 * runner clears it when nobody raises it again; an insertion outside the range keeps it.
 *
 * kata tmf5: a delta reviewer's candidate with the same file and overlapping lines as an OPEN finding of the last round, worded
 * differently and confirmed by the dedupe measure, is that finding's restatement: it is merged into the entry before it becomes a
 * candidate (named and counted in the answer and the state as `carry.restatements`), the verify round asks about fewer candidates, and
 * the entry keeps its verdict only through the carry rules it always had. A distinct defect on the same lines, a paraphrase the measure
 * cannot confirm, a finding the push touched or the verifiers refuted all stay separate candidates.
 *
 * THE BAR IS FITTED (0.35, on 45 pairs of this repository's own reviews, among them the two measured restatements), NOT validated on
 * held-out data; the paraphrase test below shows what that costs (a restatement with no shared identifier stays a candidate of its own).
 *
 * Real: git (an origin, a clone, a 19-file Medium PR, fix pushes), the CLI process (prepare and collect), prepare, the delta plan, the
 * carry hash, the fixed-finding check, the restatement match, the verify plan, the state report and the run files. Faked: `gh` (an
 * executable stub first on PATH) and the agents, which are this test writing `out-<name>.json` files exactly as a dispatched agent would.
 *
 * Fixtures live under ~/.omp/pr-review-speedup/prs-carry/fixtures (never /tmp) and are removed afterwards.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { CLAIMS: C, ROUND, RESTATEMENT, raised } = require('./helpers/pr-review-restated-claims');

jest.setTimeout(240000);

const CLI = path.join(__dirname, '..', 'lib', 'review-run-cli.js');
const FIXTURES = path.join(os.homedir(), '.omp', 'pr-review-speedup', 'prs-carry', 'fixtures');
const BODY = '## Testing\nran the relevant tests\n\n## Risk\nlow\n\n## How to revert\nrevert the commit\n';
const POLICY = '# Review\n\n```ensemble-review-policy\n{"sensitivePaths":["secure/**"],"highPaths":["wide/**"]}\n```\n';
/** The changed lines of the 19 paths of the Medium PR (the shape of the one real run): three slices, a whole-range reader and the lane. */
const LINES = [1, 127, 1, 159, 1, 145, 12, 8, 76, 125, 355, 38, 1, 8, 76, 159, 1, 145, 12];
const medPath = (index) => `med/a${String(index + 1).padStart(2, '0')}.js`;
const ALL_PATHS = LINES.map((_, index) => medPath(index));
const body = (count) => `${Array.from({ length: count }, (_, line) => `// line ${line + 1}`).join('\n')}\n`;
const STEP = 0.35;

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
  return { root, origin, work, bin, head1: git(work, 'rev-parse', 'HEAD'), baseSha: git(work, 'rev-parse', 'main'), stateFile: path.join(root, 'gh-state.json'), logFile: path.join(root, 'gh.log') };
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

const writeResult = (agent, object) => {
  fs.mkdirSync(path.dirname(agent.outPath), { recursive: true });
  const temp = `${agent.outPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(object));
  fs.renameSync(temp, agent.outPath);
};

/** Stand-in agents: every reviewer lists the paths of its slice, the reader and the lane list every path they were given. */
function answerReview(manifest, { findings = {}, lanePaths = ALL_PATHS } = {}) {
  for (const agent of manifest.agents) writeResult(agent, { findings: findings[agent.name] || [], pathsReviewed: agent.paths || lanePaths });
}
/** Every agent votes `verdict` on every candidate it holds, or `verdict(agent, candidateId)` when that is a function. */
const answerVotes = (manifest, verdict = 'real') => {
  for (const agent of manifest.agents) writeResult(agent, { votes: agent.candidateIds.map((id) => ({ candidateId: id, verdict: typeof verdict === 'function' ? verdict(agent, id) : verdict, evidence: 'read it' })) });
};
/** Votes that leave each candidate the silent verifier holds one real vote short of a strict majority of the `expected` verifiers, and confirm the rest. */
const shortOfMajority = (agents, silent, expected) => (agent, id) => {
  if (!silent.candidateIds.includes(id)) return 'real';
  const voters = agents.filter((other) => other.name !== silent.name && other.candidateIds.includes(id));
  return voters.findIndex((other) => other.name === agent.name) < Math.ceil(expected / 2) - 1 ? 'real' : 'not-real';
};

/** Round one on head1 where every verifier answers `verdict` for every candidate: the findings `byReviewer` lists are settled (or refuted). */
function settledRound(runId, byReviewer, verdict = 'real') {
  setGh({ head: fx.head1 });
  fs.rmSync(statePath(), { force: true });
  const p = prep(runId);
  expect(p.code).toBe(0);
  answerReview(p.out, { findings: byReviewer });
  const v = coll(runId);
  expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify' });
  answerVotes(v.out, verdict);
  const done = coll(runId);
  expect(done.out).toMatchObject({ ok: true, status: 'DONE', reviewStatus: { reviewedHeadSha: fx.head1 } });
  return { prepare: p.out, verify: v.out, done: done.out, state: readStateFile() };
}

/** A clock reading past every deadline: an agent whose file is not there is expired. */
const pastEveryDeadline = (hours = 2) => Date.now() + hours * 3600 * 1000;

/**
 * Round one on head1 with the four findings of ROUND (LOOP, CACHE, RETRY, LOCK): four candidates at Standard depth make a pool of four
 * verifiers holding three candidates each, so the one verifier that never writes its file leaves the three candidates it holds
 * `unverified` (verifier-incomplete) and the fourth, which its three other verifiers all answered, settled: the shape of the measured
 * High run. `severities` overrides a claim's severity by its id.
 */
function silentRound(runId, severities = {}) {
  setGh({ head: fx.head1 });
  fs.rmSync(statePath(), { force: true });
  const p = prep(runId);
  expect(p.code).toBe(0);
  const [a, b, c, d] = ROUND.map((one) => raised(one, severities[one.id] ? { severity: severities[one.id] } : {}));
  answerReview(p.out, { findings: { 'reviewer-s1-a': [a, b], 'reviewer-s2-a': [c], 'reviewer-s3-a': [d] } });
  const v = coll(runId);
  expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify' });
  expect(v.out.agents).toHaveLength(4);
  const silent = v.out.agents[0];
  answerVotes({ agents: v.out.agents.filter((agent) => agent.name !== silent.name) }, shortOfMajority(v.out.agents, silent, 3));
  const done = coll(runId, { now: pastEveryDeadline() });
  expect(done.out).toMatchObject({ ok: true, status: 'DONE', votes: { verification: 'partial' } });
  const state = readStateFile();
  const settled = state.ledger.filter((entry) => entry.verification.outcome === 'present' && entry.verification.settledOnMajority !== true);
  const waiting = state.ledger.filter((entry) => entry.verification.outcome === 'unverified');
  expect(settled).toHaveLength(1);
  expect(waiting).toHaveLength(3);
  return { prepare: p.out, verify: v.out, done: done.out, state, settled: settled[0], waiting, byAt: (at) => state.ledger.find((entry) => entry.locationOrLink === at) };
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
/** A push that touches a file no finding cites. */
const UNRELATED = { 'med/a05.js': `${body(LINES[4])}// extra\n` };
const fileOf = (location) => /^(med\/a\d+\.js):/.exec(location)[1];
const indexOf = (location) => Number(/^med\/a(\d+)\.js:/.exec(location)[1]) - 1;
/** The file of `location` with `line` edited (a one-line change). */
const editedLine = (location, line) => body(LINES[indexOf(location)]).replace(`// line ${line}\n`, `// line ${line} fixed\n`);
/** The file `index` with `count` lines added after line `after` (a pure insertion for `git diff -U0`). */
function withInsertion(index, after, count) {
  const lines = body(LINES[index]).split('\n');
  lines.splice(after, 0, ...Array.from({ length: count }, (_, k) => `// added ${k + 1}`));
  return lines.join('\n');
}

/** The delta prepare of the push `head2` on the last round `fx.head1`. */
function deltaPrepare(runId, head2) {
  const p = prep(runId, { lastReviewedSha: fx.head1, remediationShas: [head2] });
  expect(p.code).toBe(0);
  expect(p.out.reReview).toMatchObject({ scope: 'delta', appliedRange: 'delta' });
  return p.out;
}
const askedOf = (answer) => new Set(answer.agents.flatMap((agent) => agent.candidateIds));

describe('a fix that only adds lines inside a cited range clears the finding it fixes (kata bh8w)', () => {
  const RANGE = { id: 'RANGE', at: 'med/a02.js:100-118', said: 'The block on lines 100-118 clamps the index with `Math.min` but never with `Math.max`, so a negative index reads before the start of the list instead of failing.', evidence: 'Called `pick(list, -1)`: it returned the last element of the list instead of throwing.' };
  const firstWithRange = (runId) => {
    const first = settledRound(runId, { 'reviewer-s1-a': [raised(RANGE)] });
    expect(first.done.ledger).toHaveLength(1);
    expect(first.done.ledger[0]).toMatchObject({ locationOrLink: RANGE.at, verification: { outcome: 'present' } });
    return first;
  };

  test('the repro: five lines added inside the range (`@@ -104,0 +105,5 @@`) and nobody raising the finding again: it is cleared, never verified again, never counted refuted', () => {
    const first = firstWithRange('i1');
    const id = first.done.ledger[0].id;
    const head2 = push(fx.head1, { 'med/a02.js': withInsertion(1, 104, 5) }, 'ins-inside');
    expect(git(fx.work, 'diff', '-U0', fx.head1, head2, '--', 'med/a02.js')).toMatch(/^@@ -104,0 \+105,5 @@/m);
    answerReview(deltaPrepare('i2', head2));
    const done = coll('i2');
    expect(done.out).toMatchObject({ ok: true, status: 'DONE', carry: { carried: 0, cleared: [id] } });
    const entry = done.out.ledger.find((candidate) => candidate.id === id);
    expect(entry).toMatchObject({ cleared: true, clearedBy: head2 });
    // cleared is not refuted: what the verifiers said last round stays as it was
    expect(entry.verification).toMatchObject({ outcome: 'present', tally: { real: 3, notReal: 0, expected: 3 } });
    expect(done.out.ledger.filter((candidate) => candidate.verification.outcome === 'filtered')).toEqual([]);
  });

  test('the control: five lines added OUTSIDE the range keep the finding open (a fix elsewhere in the file is not a fix of it)', () => {
    const first = firstWithRange('i3');
    const id = first.done.ledger[0].id;
    const head2 = push(fx.head1, { 'med/a02.js': withInsertion(1, 122, 5) }, 'ins-outside');
    expect(git(fx.work, 'diff', '-U0', fx.head1, head2, '--', 'med/a02.js')).toMatch(/^@@ -122,0 \+123,5 @@/m);
    answerReview(deltaPrepare('i4', head2));
    const done = coll('i4');
    expect(done.out).toMatchObject({ ok: true, status: 'DONE' });
    expect(done.out.carry.cleared || []).toEqual([]);
    const entry = done.out.ledger.find((candidate) => candidate.id === id);
    expect(entry.cleared).toBeUndefined();
    expect(entry).toMatchObject({ locationOrLink: RANGE.at, verification: { outcome: 'present' } });
  });

  test('the edges: an insertion right before the first cited line or right after the last one is no fix of the range', () => {
    for (const [after, name] of [[99, 'ins-before'], [118, 'ins-after']]) {
      const first = firstWithRange(`i5-${name}`);
      const id = first.done.ledger[0].id;
      const head2 = push(fx.head1, { 'med/a02.js': withInsertion(1, after, 5) }, name);
      answerReview(deltaPrepare(`i6-${name}`, head2));
      const done = coll(`i6-${name}`);
      expect(done.out.carry.cleared || []).toEqual([]);
      expect(done.out.ledger.find((candidate) => candidate.id === id).cleared).toBeUndefined();
    }
  });
});

describe('a restatement of an open finding is that finding, not a new candidate (kata tmf5)', () => {
  const restating = (at) => raised(RESTATEMENT[at]);

  test('the live shape: a settled finding and an unverified one restated in other words are merged; the verify round asks about 4 candidates instead of 6 and the settled finding is carried', () => {
    const first = silentRound('m1');
    const head2 = push(fx.head1, UNRELATED, 'm-fix');
    const p = prep('m2', { lastReviewedSha: fx.head1, remediationShas: [head2] });
    expect(p.out.reReview).toMatchObject({ scope: 'delta', delta: { unverifiedFromLastRound: 3 } });
    // the reviewers raise the settled finding and one the last round left unverified in their own words, and one finding that is new
    answerReview(p.out, { findings: { 'reviewer-s1-a': [restating(first.settled.locationOrLink), restating(first.waiting[0].locationOrLink)], 'reviewer-s1-b': [raised(C.PARSE)] } });
    const v = coll('m2');
    // before: 6 candidates (2 restatements, 1 new, the 3 the last round left unverified) and carried 0
    expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify', carry: { carried: 1, verified: 4 } });
    const asked = askedOf(v.out);
    expect(asked.size).toBe(4);
    const summary = v.out.carry.restatements;
    expect(summary).toMatchObject({ count: 2, kept: [] });
    expect(summary.merged).toHaveLength(2);
    expect(summary.merged).toEqual(expect.arrayContaining([
      expect.objectContaining({ of: first.settled.id, carried: true, source: 'reviewer-s1-a', severity: 'important', locationOrLink: first.settled.locationOrLink }),
      expect.objectContaining({ of: first.waiting[0].id, carried: false, source: 'reviewer-s1-a' }),
    ]));
    for (const merged of summary.merged) {
      expect(merged.similarity).toBeGreaterThanOrEqual(STEP);
      expect(asked.has(merged.id)).toBe(false);
    }
    // nobody is asked about the settled finding (its verdict is carried), the three unverified ones are asked again, and the new finding is asked once
    expect(asked.has(first.settled.id)).toBe(false);
    for (const waiting of first.waiting) expect(asked.has(waiting.id)).toBe(true);
    answerVotes(v.out);
    const done = coll('m2');
    // `reverified` counts every candidate a verifier was asked about this round: the three unverified ones and the new finding
    expect(done.out).toMatchObject({ ok: true, status: 'DONE', carry: { appliedRange: 'delta', carried: 1, reverified: 4, restatements: { count: 2 } }, votes: { verification: 'performed' } });
    // the ledger holds each defect once: the four of the last round and the new one, no entry for a restating candidate
    const ids = done.out.ledger.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(5);
    for (const merged of summary.merged) expect(ids).not.toContain(merged.id);
    const settled = done.out.ledger.find((entry) => entry.id === first.settled.id);
    expect(settled).toMatchObject({ headSha: head2, carriedFrom: fx.head1, verification: { outcome: 'present' } });
    expect(settled.restatedBy).toEqual([expect.objectContaining({ id: expect.any(String), source: 'reviewer-s1-a', headSha: head2, severity: 'important', failureMode: RESTATEMENT[first.settled.locationOrLink].said })]);
    const waiting = done.out.ledger.find((entry) => entry.id === first.waiting[0].id);
    expect(waiting.carriedFrom).toBeUndefined();
    expect(waiting).toMatchObject({ verification: { outcome: 'present', reason: 'verifier-majority', tally: { real: 3, notReal: 0, expected: 3 } } });
    expect(waiting.restatedBy).toHaveLength(1);
    expect(done.out.ledger.filter((entry) => entry.restatedBy !== undefined)).toHaveLength(2);
    // the state names them too, and what the next round may carry is the carried verdict and the ones this round settled
    const state = readStateFile();
    expect(state.carry.restatements).toMatchObject({ count: 2, kept: [] });
    expect(state.verdicts.map((verdict) => verdict.id)).toEqual(expect.arrayContaining([first.settled.id, first.waiting[0].id]));
  });

  test('a restatement more severe than the finding raises it: a nit restated as Important is an Important finding, with the nit\'s decision gone', () => {
    const first = silentRound('s1', { LOOP: 'nit' });
    const target = first.byAt(C.LOOP.at);
    expect(target.severity).toBe('nit');
    const head2 = push(fx.head1, UNRELATED, 's-fix');
    answerReview(deltaPrepare('s2', head2), { findings: { 'reviewer-s1-a': [restating(C.LOOP.at)] } });
    const v = coll('s2');
    expect(v.out.carry.restatements).toMatchObject({ count: 1, merged: [expect.objectContaining({ of: target.id, severity: 'important' })] });
    answerVotes(v.out);
    const done = coll('s2');
    const entry = done.out.ledger.find((candidate) => candidate.id === target.id);
    expect(entry).toMatchObject({ severity: 'important', disposition: 'fix' });
    expect(entry.restatedBy).toEqual([expect.objectContaining({ severity: 'important', headSha: head2 })]);
    // the other three keep what they were
    expect(done.out.ledger.filter((candidate) => candidate.id !== target.id).every((candidate) => candidate.severity === 'important')).toBe(true);
  });

  test('a distinct defect on the same lines stays a separate candidate, listed as kept, while the restatement beside it merges', () => {
    const first = silentRound('d1');
    const lock = first.byAt(C.LOCK.at);
    const head2 = push(fx.head1, UNRELATED, 'd-fix');
    answerReview(deltaPrepare('d2', head2), { findings: { 'reviewer-s1-a': [raised(C.LOCK_OTHER), restating(C.LOCK.at)] } });
    const v = coll('d2');
    const summary = v.out.carry.restatements;
    expect(summary.merged).toEqual([expect.objectContaining({ of: lock.id, locationOrLink: C.LOCK.at })]);
    expect(summary.kept).toEqual([expect.objectContaining({ reason: 'different-description', against: [lock.id], similarity: expect.any(Number) })]);
    expect(summary.kept[0].similarity).toBeLessThan(STEP);
    // the distinct defect is verified, as a candidate of its own
    expect(askedOf(v.out).has(summary.kept[0].id)).toBe(true);
    answerVotes(v.out);
    const done = coll('d2');
    const other = done.out.ledger.find((entry) => entry.failureMode === C.LOCK_OTHER.said);
    expect(other).toMatchObject({ locationOrLink: C.LOCK.at, verification: { outcome: 'present' } });
    expect(other.id).not.toBe(lock.id);
    expect(other.restatedBy).toBeUndefined();
    expect(done.out.ledger.find((entry) => entry.id === lock.id).restatedBy).toHaveLength(1);
    expect(done.out.ledger).toHaveLength(5);
  });

  test('what the bar cannot confirm stays a separate candidate: a paraphrase with no shared identifier is kept (the cost of a lexical bar), and both entries stay open', () => {
    const first = silentRound('p1');
    const cache = first.byAt(C.CACHE.at);
    const head2 = push(fx.head1, UNRELATED, 'p-fix');
    answerReview(deltaPrepare('p2', head2), { findings: { 'reviewer-s1-a': [raised(C.CACHE_ABSTRACT)] } });
    const v = coll('p2');
    expect(v.out.carry.restatements).toMatchObject({ count: 0, merged: [], kept: [expect.objectContaining({ reason: 'different-description', against: [cache.id] })] });
    expect(v.out.carry.restatements.kept[0].similarity).toBeLessThan(STEP);
    expect(askedOf(v.out).has(v.out.carry.restatements.kept[0].id)).toBe(true);
    answerVotes(v.out);
    const done = coll('p2');
    expect(done.out.ledger.filter((entry) => entry.locationOrLink === C.CACHE.at)).toHaveLength(2);
    expect(done.out.ledger.filter((entry) => entry.restatedBy !== undefined)).toEqual([]);
  });

  test('a finding whose cited lines the push touched is never merged into: it is cleared like any fixed finding and the candidate is a finding of its own', () => {
    const first = silentRound('t1');
    const loop = first.byAt(C.LOOP.at);
    const head2 = push(fx.head1, { [fileOf(C.LOOP.at)]: editedLine(C.LOOP.at, 5) }, 't-fix');
    answerReview(deltaPrepare('t2', head2), { findings: { 'reviewer-s1-a': [restating(C.LOOP.at)] } });
    const v = coll('t2');
    expect(v.out.carry.restatements).toBeUndefined();
    answerVotes(v.out);
    const done = coll('t2');
    expect(done.out.carry.restatements).toBeUndefined();
    expect(done.out.ledger.find((entry) => entry.id === loop.id)).toMatchObject({ cleared: true, clearedBy: head2 });
    const again = done.out.ledger.find((entry) => entry.failureMode === C.LOOP_AGAIN.said);
    expect(again).toMatchObject({ locationOrLink: C.LOOP.at, verification: { outcome: 'present' } });
    expect(again.id).not.toBe(loop.id);
    expect(done.out.ledger.filter((entry) => entry.restatedBy !== undefined)).toEqual([]);
  });

  test('a finding the verifiers refuted is never merged into: the restating candidate is verified on its own', () => {
    const first = settledRound('f1', { 'reviewer-s1-a': [raised(C.LOOP)] }, 'not-real');
    expect(first.done.ledger).toHaveLength(1);
    expect(first.done.ledger[0].verification.outcome).toBe('filtered');
    const head2 = push(fx.head1, UNRELATED, 'f-fix');
    answerReview(deltaPrepare('f2', head2), { findings: { 'reviewer-s1-a': [restating(C.LOOP.at)] } });
    const v = coll('f2');
    expect(v.out.carry.restatements).toBeUndefined();
    expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify', carry: { carried: 0, verified: 1 } });
    answerVotes(v.out);
    const done = coll('f2');
    expect(done.out.ledger.filter((entry) => entry.restatedBy !== undefined)).toEqual([]);
    expect(done.out.ledger.map((entry) => entry.verification.outcome).sort()).toEqual(['filtered', 'present']);
  });

  test('the carry rules are not loosened: a restated settled finding in a file the push edited elsewhere is verified again, as itself, never carried', () => {
    const first = silentRound('c1');
    const target = first.settled;
    const head2 = push(fx.head1, { [fileOf(target.locationOrLink)]: editedLine(target.locationOrLink, 100) }, 'c-fix');
    answerReview(deltaPrepare('c2', head2), { findings: { 'reviewer-s1-a': [restating(target.locationOrLink)] } });
    const v = coll('c2');
    // the entry is restated and its file is in the delta: planCarry refuses it, so it is one of the 4 asked about (the 3 unverified ones and itself)
    expect(v.out).toMatchObject({ status: 'DISPATCH', round: 'verify', carry: { carried: 0, verified: 4 } });
    expect(v.out.carry.restatements).toMatchObject({ count: 1, merged: [expect.objectContaining({ of: target.id, carried: false })] });
    expect(askedOf(v.out).has(target.id)).toBe(true);
    answerVotes(v.out);
    const done = coll('c2');
    const entry = done.out.ledger.find((candidate) => candidate.id === target.id);
    expect(entry.carriedFrom).toBeUndefined();
    expect(entry).toMatchObject({ verification: { outcome: 'present', reason: 'verifier-majority', tally: { real: 3, notReal: 0, expected: 3 } } });
    expect(entry.restatedBy).toHaveLength(1);
    expect(done.out.ledger).toHaveLength(4);
  });
});
