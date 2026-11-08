'use strict';

/** The pure steps of the runner's delta re-review (kata xb4j); the whole path is proven through the real CLI in review-run-delta-cli.test.js. */

const { priorRound, deltaScope, idSeed, hashCandidates, planRunCarry } = require('../lib/pr-review-run-delta');

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const goodState = () => ({
  prId: '7', runId: 'r1', headSha: HEAD, reviewedHeadSha: HEAD, baseSha: BASE,
  ledger: [{ id: 'f1' }], verdicts: [{ id: 'f1' }],
  notReviewed: { unreviewedSlices: [], unreviewedPaths: [], incompleteVerifiers: [], unbriefable: [], expiredAgents: [] },
  security: { status: 'clean', findings: [] },
});
const goodRun = () => ({ schema: 1, phase: 'done', headSha: HEAD, baseSha: BASE, pr: 7 });
const ask = (over = {}) => priorRound({
  read: () => ({ ok: true, exists: true, discarded: false, state: goodState() }),
  readRun: () => goodRun(),
  pr: 7,
  lastReviewedSha: HEAD,
  ...over,
});

describe('priorRound: the last round the runner can stand on', () => {
  test('a whole, recorded round is usable', () => {
    expect(ask()).toMatchObject({ ok: true, runId: 'r1' });
  });

  test.each([
    ['no reader', { read: undefined }, 'state-reader-unavailable'],
    ['a reader that throws', { read: () => { throw new Error('x'); } }, 'state-unreadable'],
    ['an unreadable state', { read: () => ({ ok: false, reason: 'corrupt' }) }, 'state-unreadable'],
    ['no state file', { read: () => ({ ok: true, exists: false }) }, 'state-absent'],
    ['a state of another head', { read: () => ({ ok: true, exists: true, discarded: true, state: null }) }, 'state-other-head'],
    ['a state of another PR', { pr: 8 }, 'state-other-pr'],
    ['a run record that is not done', { readRun: () => ({ ...goodRun(), phase: 'review-dispatched' }) }, 'state-run-record-mismatch'],
    ['a run record of another head', { readRun: () => ({ ...goodRun(), headSha: 'c'.repeat(40) }) }, 'state-run-record-mismatch'],
    ['a run record of another base', { readRun: () => ({ ...goodRun(), baseSha: 'c'.repeat(40) }) }, 'state-run-record-mismatch'],
    ['no run record', { readRun: () => null }, 'state-run-record-mismatch'],
  ])('%s is never a base', (_name, over, reason) => {
    expect(ask(over)).toEqual({ ok: false, reason });
  });

  const withState = (change) => ask({ read: () => ({ ok: true, exists: true, discarded: false, state: change(goodState()) }) });
  test.each([
    ['a reviewed head that is not the head named', (s) => ({ ...s, reviewedHeadSha: 'c'.repeat(40) }), 'state-other-head'],
    ['no base', (s) => ({ ...s, baseSha: 'main' }), 'state-base-unknown'],
    ['no run id', (s) => ({ ...s, runId: undefined }), 'state-not-from-a-run'],
    ['an unreadable ledger', (s) => ({ ...s, ledger: 'x' }), 'state-ledger-unreadable'],
    ['no verdicts', (s) => ({ ...s, verdicts: undefined }), 'state-verdicts-unrecorded'],
    ['an unreviewed slice', (s) => ({ ...s, notReviewed: { ...s.notReviewed, unreviewedSlices: ['whole-pr'] } }), 'state-round-incomplete'],
    ['an expired agent (a security lane that never returned is recorded not-run)', (s) => ({ ...s, security: { status: 'not-run', findings: [] }, notReviewed: { ...s.notReviewed, expiredAgents: [{ name: 'security-lane' }] } }), 'state-round-incomplete'],
    ['an incomplete verifier', (s) => ({ ...s, notReviewed: { ...s.notReviewed, incompleteVerifiers: [{ name: 'verifier-1' }] } }), 'state-round-incomplete'],
    ['an unreviewed path', (s) => ({ ...s, notReviewed: { ...s.notReviewed, unreviewedPaths: ['src/a.js'] } }), 'state-round-incomplete'],
    ['an unbriefable candidate', (s) => ({ ...s, notReviewed: { ...s.notReviewed, unbriefable: [{ id: 'f2' }] } }), 'state-round-incomplete'],
    ['a missing coverage list', (s) => ({ ...s, notReviewed: { unreviewedSlices: [] } }), 'state-round-incomplete'],
    ['a security finding', (s) => ({ ...s, security: { status: 'findings', findings: [{}] } }), 'state-security-open'],
    ['an unavailable lane', (s) => ({ ...s, security: { status: 'unavailable' } }), 'state-security-open'],
  ])('%s is never a base', (_name, change, reason) => {
    expect(withState(change)).toEqual({ ok: false, reason });
  });
});

describe('deltaScope: what a delta round reads', () => {
  const diff = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+newer', ''].join('\n');
  const facts = () => ({ deltaPlan: { mode: 'delta', readSet: [{ path: 'src/b.js', reasons: ['caller-of:src/a.js'] }, { path: 'src/a.js', reasons: ['changed'] }] }, delta: { changedPaths: ['src/a.js'] } });

  test('the read set, sorted, with the delta diff\'s own line counts (a caller with no hunk counts 0)', () => {
    expect(deltaScope(facts(), diff)).toEqual({
      ok: true,
      readPaths: ['src/a.js', 'src/b.js'],
      changedPaths: ['src/a.js'],
      numstat: [{ path: 'src/a.js', added: 2, deleted: 1, binary: false }, { path: 'src/b.js', added: 0, deleted: 0, binary: false }],
    });
  });

  test.each([
    ['a full plan', (f) => ({ ...f, deltaPlan: { mode: 'full', reasons: [], readSet: [] } }), 'delta-read-set-unreadable'],
    ['an empty read set', (f) => ({ ...f, deltaPlan: { mode: 'delta', readSet: [] } }), 'delta-read-set-unreadable'],
    ['a read set entry with no path', (f) => ({ ...f, deltaPlan: { mode: 'delta', readSet: [{ reasons: [] }] } }), 'delta-read-set-unreadable'],
    ['no changed paths', (f) => ({ ...f, delta: { changedPaths: [] } }), 'delta-paths-unreadable'],
    ['no delta', (f) => ({ ...f, delta: undefined }), 'delta-paths-unreadable'],
  ])('%s is no delta read', (_name, change, reason) => {
    expect(deltaScope(change(facts()), diff)).toEqual({ ok: false, reason });
  });

  test('a delta diff that cannot be read is no delta read', () => {
    expect(deltaScope(facts(), null)).toEqual({ ok: false, reason: 'delta-diff-unreadable' });
  });
});

describe('idSeed and hashing', () => {
  test('a new round\'s ids start after the highest id of the prior ledger, merged ones included', () => {
    expect(idSeed([{ id: 'f1' }, { id: 'f7', mergedFrom: [{ id: 'f9' }, { id: 'x' }] }, { id: 's3' }])).toBe(9);
    expect(idSeed([])).toBe(0);
  });

  test('a candidate that cannot be hashed comes back stamped with the head and no hash, never dropped', () => {
    const run = { headSha: HEAD, repoRoot: '/r', prepared: { snapshotDir: '/s' } };
    const candidates = [{ id: 'f1', locationOrLink: 'src/a.js:3', failureMode: 'x' }, { id: 'f2', locationOrLink: 'https://example.invalid/1', failureMode: 'y' }];
    for (const hash of [null, () => { throw new Error('git failed'); }, () => ({ ok: false, error: 'nope' }), () => ({ ok: true, candidates: [] })]) {
      const out = hashCandidates(run, candidates, hash);
      expect(out.map((e) => [e.id, e.headSha, e.hunkHash])).toEqual([['f1', HEAD, undefined], ['f2', HEAD, undefined]]);
      expect(out.every((e) => typeof e.hashError === 'string')).toBe(true);
    }
    expect(hashCandidates(run, [], null)).toEqual([]);
  });

  test('a delta round with no usable prior carries nothing and says so', () => {
    const run = { candidates: [{ id: 'f1' }], priorRound: undefined, carryFacts: undefined };
    expect(planRunCarry(run, [])).toMatchObject({ planOk: false, carriedIds: [], reasons: ['no-prior-round'] });
  });
});
