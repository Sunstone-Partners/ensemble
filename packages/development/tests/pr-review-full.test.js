'use strict';

/**
 * pr-review-full.js (kata dqcs): the re-review scope rule, the triage payload and the no-downgrade invariant.
 * Each case names the guard it covers and fails when that guard is removed.
 */

const { planReReview, validateTriage, modeInvariant, MAX_ADDITIONAL_CANDIDATES } = require('../lib/pr-review-full');

const LAST = '1'.repeat(40);
const entry = (path, over = {}) => ({ path, sensitive: false, high: false, declarationFile: false, ...over });
const base = (over = {}) => ({
  lastReviewedSha: LAST,
  rangeMode: 'delta',
  deltaPlan: { mode: 'delta', reasons: ['delta-since-last-review'], readSet: [] },
  delta: { lastReviewedSha: LAST, reviewedHeadSha: LAST, reviewedBaseSha: 'b'.repeat(40), changedPaths: ['src/a.js'] },
  paths: { sensitive: ['secure/k.js'], high: ['core/x.js'], paths: [entry('src/a.js'), entry('secure/k.js', { sensitive: true }), entry('core/x.js', { high: true })] },
  ...over,
});

describe('planReReview', () => {
  test('no previous head is a first review', () => {
    expect(planReReview(base({ lastReviewedSha: undefined }))).toEqual({ scope: 'first-review', reasons: ['no-previous-head'], appliedRange: 'full-range' });
  });

  test('a safe delta is delta, and says the whole range is still what is read', () => {
    expect(planReReview(base())).toEqual({ scope: 'delta', reasons: [], appliedRange: 'full-range' });
  });

  const full = (name, over, reason) => test(`${name}: full, naming ${reason}`, () => {
    const answer = planReReview(base(typeof over === 'function' ? over(base()) : over));
    expect(answer.scope).toBe('full');
    expect(answer.reasons).toContain(reason);
  });

  full('a High path in the delta', (b) => ({ delta: { ...b.delta, changedPaths: ['core/x.js'] } }), 'high-path-touched');
  full('a sensitive path in the delta', (b) => ({ delta: { ...b.delta, changedPaths: ['src/a.js', 'secure/k.js'] } }), 'sensitive-path-touched');
  full('a declaration file in the delta', (b) => ({ paths: { ...b.paths, paths: [entry('src/a.js', { declarationFile: true })] } }), 'sensitive-path-touched');
  full('a path the High list names even when the entry flag is missing', (b) => ({ paths: { ...b.paths, high: ['src/a.js'] } }), 'high-path-touched');
  full('a head the review state never recorded', (b) => ({ delta: { ...b.delta, reviewedHeadSha: '2'.repeat(40) } }), 'head-never-seen');
  full('no record of a reviewed head at all', (b) => ({ delta: { ...b.delta, reviewedHeadSha: undefined } }), 'head-never-seen');
  full('a range that is full', { rangeMode: 'full' }, 'range-is-full');
  full('a plan that says full (its own reasons are kept)', { deltaPlan: { mode: 'full', reasons: ['import-graph-unavailable'], readSet: [] } }, 'import-graph-unavailable');
  full('a missing plan', { deltaPlan: undefined }, 'delta-plan-full');
  full('an unreadable delta', { delta: null }, 'delta-unreadable');
  full('an empty delta', (b) => ({ delta: { ...b.delta, changedPaths: [] } }), 'empty-delta');
  full('a delta path the classification does not cover', (b) => ({ delta: { ...b.delta, changedPaths: ['src/new.js'] } }), 'classification-incomplete');
  full('no classification', { paths: undefined }, 'classification-unreadable');
  full('an unreadable previous head', { lastReviewedSha: 42 }, 'previous-head-unreadable');

  test('a plan that says delta cannot narrow a review whose own classification says the delta is sensitive', () => {
    const answer = planReReview(base({ deltaPlan: { mode: 'delta', reasons: [], readSet: [] }, delta: { ...base().delta, changedPaths: ['secure/k.js'] } }));
    expect(answer.scope).toBe('full');
  });

  test('every reason is listed, none dropped', () => {
    const answer = planReReview(base({ rangeMode: 'full', delta: { ...base().delta, changedPaths: ['core/x.js', 'secure/k.js'], reviewedHeadSha: '2'.repeat(40) } }));
    expect(answer.reasons).toEqual(expect.arrayContaining(['range-is-full', 'high-path-touched', 'sensitive-path-touched', 'head-never-seen']));
  });
});

describe('validateTriage', () => {
  const ok = { locationOrLink: 'src/a.js:12', failureMode: 'the loop reads past the end' };

  test('an empty triage adds nothing', () => {
    expect(validateTriage({})).toEqual({ ok: true, additional: [] });
    expect(validateTriage({ additionalCandidates: [] })).toEqual({ ok: true, additional: [] });
  });

  test('a candidate is completed with the honest defaults and trimmed', () => {
    const answer = validateTriage({ additionalCandidates: [{ ...ok, locationOrLink: ' src/a.js:12-14 ' }] });
    expect(answer.ok).toBe(true);
    expect(answer.additional[0]).toMatchObject({ locationOrLink: 'src/a.js:12-14', originalTextOrLink: 'src/a.js:12-14', severity: 'important', disposition: 'fix' });
    expect(answer.additional[0].evidence).toMatch(/not yet verified/);
  });

  test.each([
    ['not an object', null, /JSON object/],
    ['an array', [], /JSON object/],
    ['an unknown top-level key', { remove: ['f1'] }, /unknown triage key "remove"/],
    ['additionalCandidates not an array', { additionalCandidates: {} }, /must be an array/],
    ['a non-object candidate', { additionalCandidates: ['x'] }, /must be an object/],
    ['an unknown candidate key', { additionalCandidates: [{ ...ok, blocking: false }] }, /unknown key "blocking"/],
    ['a location without a line', { additionalCandidates: [{ ...ok, locationOrLink: 'src/a.js' }] }, /file:line/],
    ['a location that is a link', { additionalCandidates: [{ ...ok, locationOrLink: 'https://example.invalid/x' }] }, /file:line/],
    ['an absolute path', { additionalCandidates: [{ ...ok, locationOrLink: '/etc/passwd:1' }] }, /repository-relative/],
    ['a home-relative path', { additionalCandidates: [{ ...ok, locationOrLink: '~/.ssh/id_rsa:1' }] }, /repository-relative/],
    ['a .. segment', { additionalCandidates: [{ ...ok, locationOrLink: 'src/../../x.js:1' }] }, /repository-relative/],
    ['a leading ..', { additionalCandidates: [{ ...ok, locationOrLink: '../x.js:1' }] }, /repository-relative/],
    ['a . segment', { additionalCandidates: [{ ...ok, locationOrLink: 'src/./a.js:1' }] }, /repository-relative/],
    ['an empty segment', { additionalCandidates: [{ ...ok, locationOrLink: 'src//a.js:1' }] }, /repository-relative/],
    ['a backslash', { additionalCandidates: [{ ...ok, locationOrLink: 'src\\a.js:1' }] }, /repository-relative/],
    ['a blank failure mode', { additionalCandidates: [{ ...ok, failureMode: '  ' }] }, /failureMode/],
    ['a pre-existing severity', { additionalCandidates: [{ ...ok, severity: 'pre-existing' }] }, /important, nit/],
    ['an unknown severity', { additionalCandidates: [{ ...ok, severity: 'critical' }] }, /important, nit/],
    ['non-text evidence', { additionalCandidates: [{ ...ok, evidence: 3 }] }, /evidence/],
  ])('%s is refused', (_name, payload, reason) => {
    const answer = validateTriage(payload);
    expect(answer.ok).toBe(false);
    expect(answer.reason).toMatch(reason);
  });

  test('the cap is exact: 20 pass, 21 do not', () => {
    const many = (n) => ({ additionalCandidates: Array.from({ length: n }, (_, i) => ({ locationOrLink: `src/a.js:${i + 1}`, failureMode: 'something is wrong' })) });
    expect(validateTriage(many(MAX_ADDITIONAL_CANDIDATES)).ok).toBe(true);
    expect(validateTriage(many(MAX_ADDITIONAL_CANDIDATES + 1)).ok).toBe(false);
  });
});

describe('modeInvariant', () => {
  const run = (over = {}) => ({ mode: { mode: 'full' }, depth: { mode: 'deep', reviewersPerSlice: 2, verifiersPerCandidate: 5 }, securityLane: true, ...over });

  test('a full run at Deep with the lane holds', () => {
    expect(modeInvariant(run())).toBeNull();
    expect(modeInvariant(run({ depth: { mode: 'deep', reviewersPerSlice: 3, verifiersPerCandidate: 7 } }))).toBeNull();
  });

  test.each([
    ['depth', { depth: { mode: 'standard', reviewersPerSlice: 2, verifiersPerCandidate: 5 } }, /deep depth/],
    ['reviewers', { depth: { mode: 'deep', reviewersPerSlice: 1, verifiersPerCandidate: 5 } }, /reviewers per slice/],
    ['verifiers', { depth: { mode: 'deep', reviewersPerSlice: 2, verifiersPerCandidate: 4 } }, /verifiers per finding/],
    ['a missing depth', { depth: undefined }, /deep depth/],
    ['the lane', { securityLane: false }, /security lane/],
  ])('a full run below the bar on %s does not hold', (_name, over, reason) => {
    expect(modeInvariant(run(over))).toMatch(reason);
  });

  test('light runs and unreadable records are not this guard\'s business', () => {
    expect(modeInvariant({ mode: { mode: 'light' }, depth: { mode: 'standard' } })).toBeNull();
    expect(modeInvariant(null)).toBeNull();
  });
});
