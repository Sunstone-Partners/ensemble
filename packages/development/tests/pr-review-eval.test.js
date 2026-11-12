'use strict';

/**
 * TRD-031: Eval-set scorer and staleness (`pr-review-eval.js`).
 *
 * Validates PRD ACs: AC-020-1, AC-020-2, AC-020-3 (REQ-020).
 *
 * These are the Implementation AC tests. The PRD-scenario tests live in
 * TRD-031-TEST.
 *
 * What is pinned here:
 *   1. a case is valid only when a CODEOWNERS owner of the affected path
 *      confirmed it -- an unconfirmed case, a confirmation by a non-owner, or
 *      a path with no owner at all, is REJECTED (AC-020-1);
 *   2. a case counts as found only when an IMPORTANT finding overlaps the
 *      recorded bug location; per-case results and a total are reported
 *      (AC-020-2);
 *   3. a run that finds fewer cases than the previous run is flagged as a
 *      regression and names the cases that flipped (AC-020-3);
 *   4. a changed rules-file hash makes the case stale for owner re-review,
 *      and only `<id>.json` files under the policy `evalCasesDir` are loaded.
 *
 * Fail-closed throughout: a request this module cannot read is never a valid
 * case, never a found case and never "no regression".
 */

const {
  validateCase,
  scoreEval,
  compareEval,
  staleCases,
  DEFAULT_EVAL_CASES_DIR,
} = require('../lib/pr-review-eval');

const CODEOWNERS = [
  '# owners',
  '*               @fallback-owner',
  '/packages/development/lib/  @lib-owner @second-owner',
  '/docs/                      @docs-owner',
].join('\n');

const evalCase = (overrides = {}) => ({
  id: 'case-001',
  change: 'abc1234',
  bug: 'the retry loop never terminates when the server returns 429',
  location: { path: 'packages/development/lib/retry.js', startLine: 40, endLine: 52 },
  confirmedBy: '@lib-owner',
  rulesFile: 'packages/development/REVIEW.md',
  rulesHash: 'hash-v1',
  ...overrides,
});

const finding = (overrides = {}) => ({
  id: 'f1',
  source: 'code-reviewer',
  locationOrLink: 'packages/development/lib/retry.js:45',
  severity: 'important',
  failureMode: 'infinite-retry',
  disposition: 'fix',
  evidence: 'no backoff cap',
  originalTextOrLink: 'review-round-1',
  ...overrides,
});

// ---------------------------------------------------------------------------
// AC-020-1: owner confirmation and case location
// ---------------------------------------------------------------------------

describe('TRD-031 AC-020-1: a case is valid only when its code owner confirmed it', () => {
  test('a complete case confirmed by an owner of the affected path is valid', () => {
    const result = validateCase({ case: evalCase(), codeowners: CODEOWNERS, path: 'docs/review-eval/cases/case-001.json' });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.owners).toEqual(['@lib-owner', '@second-owner']);
  });

  test('the login may be written with or without the @', () => {
    const result = validateCase({ case: evalCase({ confirmedBy: 'Second-Owner' }), codeowners: CODEOWNERS });
    expect(result.ok).toBe(true);
  });

  test('negative control: a confirmation by someone who does not own the path is rejected', () => {
    const result = validateCase({ case: evalCase({ confirmedBy: '@docs-owner' }), codeowners: CODEOWNERS });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.reason)).toContain('confirmed-by-not-owner');
  });

  test('negative control: a case with no confirmation at all is rejected', () => {
    const result = validateCase({ case: evalCase({ confirmedBy: '' }), codeowners: CODEOWNERS });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain('confirmedBy');
  });

  test('a path whose owner cannot be resolved is rejected, never assumed confirmed', () => {
    const noOwners = validateCase({ case: evalCase(), codeowners: '' });
    expect(noOwners.ok).toBe(false);
    expect(noOwners.errors.map((e) => e.reason)).toContain('no-code-owner');

    const teamOwned = validateCase({
      case: evalCase({ confirmedBy: '@someone' }),
      codeowners: '/packages/development/lib/ @org/platform-team',
    });
    expect(teamOwned.ok).toBe(false);
    expect(teamOwned.errors.map((e) => e.reason)).toContain('confirmed-by-not-owner');
  });

  test('every required field is graded, so an incomplete case cannot be scored', () => {
    for (const missing of ['id', 'change', 'bug', 'location', 'rulesFile', 'rulesHash']) {
      const broken = evalCase();
      delete broken[missing];
      const result = validateCase({ case: broken, codeowners: CODEOWNERS });
      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.field)).toContain(missing);
    }
  });

  test('a malformed bug location is rejected', () => {
    for (const location of [
      { path: '', startLine: 1, endLine: 2 },
      { path: 'a.js', startLine: 0, endLine: 2 },
      { path: 'a.js', startLine: 5, endLine: 2 },
      { path: 'a.js', startLine: '1', endLine: 2 },
      'a.js:1-2',
      null,
    ]) {
      expect(validateCase({ case: evalCase({ location }), codeowners: CODEOWNERS }).ok).toBe(false);
    }
  });

  test('fail closed: a request shape it cannot read is not a valid case', () => {
    for (const bad of [null, undefined, 'case', [], { case: null }, { case: [] }]) {
      const result = validateCase(bad);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('TRD-031 AC-020-1: only <id>.json under evalCasesDir is loaded', () => {
  test('the default directory is the one the data model fixes', () => {
    expect(DEFAULT_EVAL_CASES_DIR).toBe('docs/review-eval/cases');
  });

  test('a case file outside the directory is not loaded', () => {
    const result = validateCase({
      case: evalCase(),
      codeowners: CODEOWNERS,
      path: 'docs/elsewhere/case-001.json',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.reason)).toContain('case-outside-eval-dir');
  });

  test('a traversal out of the directory is not loaded', () => {
    const result = validateCase({
      case: evalCase(),
      codeowners: CODEOWNERS,
      path: 'docs/review-eval/cases/../../secrets/case-001.json',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.reason)).toContain('case-outside-eval-dir');
  });

  test('the file name must be the case id with a .json suffix', () => {
    const result = validateCase({
      case: evalCase(),
      codeowners: CODEOWNERS,
      path: 'docs/review-eval/cases/other-name.json',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.reason)).toContain('case-filename-mismatch');
  });

  test('a configured evalCasesDir is honoured', () => {
    const result = validateCase({
      case: evalCase(),
      codeowners: CODEOWNERS,
      evalCasesDir: 'review/cases',
      path: 'review/cases/case-001.json',
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-020-2: scoring a run
// ---------------------------------------------------------------------------

describe('TRD-031 AC-020-2: each case is scored for whether the reviewer found the bug', () => {
  const cases = [evalCase(), evalCase({ id: 'case-002', location: { path: 'src/a.js', startLine: 1, endLine: 3 } })];

  test('an Important finding inside the bug location counts as found', () => {
    const result = scoreEval({ cases, findingsByCase: { 'case-001': [finding()], 'case-002': [] } });

    expect(result.ok).toBe(true);
    expect(result.cases).toEqual([
      expect.objectContaining({ id: 'case-001', found: true, matchedFindingId: 'f1' }),
      expect.objectContaining({ id: 'case-002', found: false, matchedFindingId: null }),
    ]);
    expect(result.total).toEqual({ cases: 2, found: 1, score: 0.5 });
  });

  test('a legacy Critical/Major finding still counts: it reads as Important', () => {
    const result = scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [finding({ severity: 'critical' })] } });
    expect(result.total.found).toBe(1);
  });

  test('negative control: a Nit or Pre-existing finding at the exact line does NOT count', () => {
    for (const severity of ['nit', 'nitpick', 'minor', 'pre-existing', 'whatever']) {
      const result = scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [finding({ severity })] } });
      expect(result.total.found).toBe(0);
      expect(result.cases[0].reason).toBe('no-important-finding-at-location');
    }
  });

  test('negative control: an Important finding in another file or outside the line range does not count', () => {
    const elsewhere = finding({ locationOrLink: 'packages/development/lib/other.js:45' });
    const above = finding({ locationOrLink: 'packages/development/lib/retry.js:39' });
    const below = finding({ locationOrLink: 'packages/development/lib/retry.js:53' });
    for (const found of [elsewhere, above, below]) {
      expect(scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [found] } }).total.found).toBe(0);
    }
    expect(scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [finding({ locationOrLink: 'packages/development/lib/retry.js:40' })] } }).total.found).toBe(1);
    expect(scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [finding({ locationOrLink: 'packages/development/lib/retry.js:52' })] } }).total.found).toBe(1);
  });

  test('an unanchored finding (a bare link) cannot vouch for a location', () => {
    const result = scoreEval({
      cases: [evalCase()],
      findingsByCase: { 'case-001': [finding({ locationOrLink: 'https://example.invalid/pull/1' })] },
    });
    expect(result.total.found).toBe(0);
  });

  test('a case with no findings recorded at all is reported as not found, not skipped', () => {
    const result = scoreEval({ cases: [evalCase()], findingsByCase: {} });
    expect(result.cases[0].found).toBe(false);
    expect(result.cases[0].reason).toBe('no-findings-recorded');
    expect(result.total).toEqual({ cases: 1, found: 0, score: 0 });
  });

  test('an empty eval set scores zero without dividing by zero', () => {
    expect(scoreEval({ cases: [], findingsByCase: {} }).total).toEqual({ cases: 0, found: 0, score: 0 });
  });

  test('fail closed: an unreadable request is refused, never a perfect score', () => {
    for (const bad of [null, { cases: 'all', findingsByCase: {} }, { cases: [null], findingsByCase: {} }, { cases: [evalCase()], findingsByCase: [] }]) {
      const result = scoreEval(bad);
      expect(result.ok).toBe(false);
      expect(result.total).toEqual({ cases: 0, found: 0, score: 0 });
    }
  });

  test('findings that are not objects are ignored, and the case stays not found', () => {
    const result = scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [null, 'finding', 7] } });
    expect(result.ok).toBe(true);
    expect(result.cases[0].found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-020-3: comparing two runs
// ---------------------------------------------------------------------------

describe('TRD-031 AC-020-3: a lower total than the previous run is a regression', () => {
  const run = (entries) => ({ cases: entries.map(([id, found]) => ({ id, found })) });

  test('a dropped case is a regression and is named', () => {
    const result = compareEval({
      previous: run([['c1', true], ['c2', true]]),
      current: run([['c1', true], ['c2', false]]),
    });

    expect(result.ok).toBe(true);
    expect(result.regression).toBe(true);
    expect(result.flipped).toEqual([{ id: 'c2', from: true, to: false }]);
    expect(result.previousFound).toBe(2);
    expect(result.currentFound).toBe(1);
    expect(result.delta).toBe(-1);
  });

  test('negative control: an equal or better run is not a regression', () => {
    const same = compareEval({ previous: run([['c1', true]]), current: run([['c1', true]]) });
    expect(same.regression).toBe(false);
    expect(same.flipped).toEqual([]);

    const better = compareEval({ previous: run([['c1', false]]), current: run([['c1', true]]) });
    expect(better.regression).toBe(false);
    expect(better.delta).toBe(1);
    expect(better.gained).toEqual([{ id: 'c1', from: false, to: true }]);
  });

  test('a swap that keeps the total equal still names the case that flipped', () => {
    const result = compareEval({
      previous: run([['c1', true], ['c2', false]]),
      current: run([['c1', false], ['c2', true]]),
    });
    expect(result.delta).toBe(0);
    expect(result.regression).toBe(true);
    expect(result.flipped).toEqual([{ id: 'c1', from: true, to: false }]);
  });

  test('a case dropped from the current run counts as lost, not as absent', () => {
    const result = compareEval({ previous: run([['c1', true], ['c2', true]]), current: run([['c1', true]]) });
    expect(result.regression).toBe(true);
    expect(result.missing).toEqual(['c2']);
  });

  test('fail closed: a comparison it cannot read is reported as a regression', () => {
    for (const bad of [null, {}, { previous: null, current: { cases: [] } }, { previous: { cases: [] }, current: 'x' }]) {
      const result = compareEval(bad);
      expect(result.ok).toBe(false);
      expect(result.regression).toBe(true);
    }
  });

  test('fail closed: a run that reports its own failure is never compared as "no regression"', () => {
    // A `scoreEval` failure carries `ok:false` AND an empty `cases` array. Read
    // only as `{ cases: [] }`, two such runs compare as "nothing lost" -- the
    // eval harness would report all-clear for two runs that never scored
    // anything. A run that says it failed is unreadable evidence, not a zero.
    const failed = scoreEval({ cases: 'not-an-array', findingsByCase: {} });
    expect(failed.ok).toBe(false);

    const both = compareEval({ previous: failed, current: failed });
    expect(both.ok).toBe(false);
    expect(both.regression).toBe(true);
    expect(both.reason).toMatch(/previous/);

    const currentFailed = compareEval({ previous: run([['c1', true]]), current: failed });
    expect(currentFailed.ok).toBe(false);
    expect(currentFailed.regression).toBe(true);
    expect(currentFailed.reason).toMatch(/current/);
  });

  test('negative control: a run with no `ok` field at all is still comparable', () => {
    // The documented input is "a scoreEval result, OR any { cases: [{id, found}] }".
    // Rejecting a bare run would break that contract, so only an explicit
    // `ok:false` is refused.
    const result = compareEval({ previous: run([['c1', true]]), current: run([['c1', true]]) });
    expect(result.ok).toBe(true);
    expect(result.regression).toBe(false);
  });

  test('a scoreEval result feeds compareEval directly', () => {
    const previous = scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [finding()] } });
    const current = scoreEval({ cases: [evalCase()], findingsByCase: { 'case-001': [finding({ severity: 'nit' })] } });
    const result = compareEval({ previous, current });
    expect(result.regression).toBe(true);
    expect(result.flipped).toEqual([{ id: 'case-001', from: true, to: false }]);
  });
});

// ---------------------------------------------------------------------------
// AC-020-1 (second half): staleness when the area's rules change
// ---------------------------------------------------------------------------

describe('TRD-031: a changed rules file makes its cases stale', () => {
  const cases = [evalCase(), evalCase({ id: 'case-002', rulesFile: 'REVIEW.md', rulesHash: 'root-v1' })];

  test('a changed hash returns the affected cases for owner re-review', () => {
    const result = staleCases({
      cases,
      rulesHashes: { 'packages/development/REVIEW.md': 'hash-v2', 'REVIEW.md': 'root-v1' },
    });
    expect(result.ok).toBe(true);
    expect(result.stale).toEqual(['case-001']);
    expect(result.reasons['case-001']).toBe('rules-hash-changed');
  });

  test('negative control: unchanged hashes leave every case current', () => {
    const result = staleCases({
      cases,
      rulesHashes: { 'packages/development/REVIEW.md': 'hash-v1', 'REVIEW.md': 'root-v1' },
    });
    expect(result.stale).toEqual([]);
  });

  test('a rules file that is gone or unknown makes the case stale, never current', () => {
    const result = staleCases({ cases, rulesHashes: { 'REVIEW.md': 'root-v1' } });
    expect(result.stale).toEqual(['case-001']);
    expect(result.reasons['case-001']).toBe('rules-file-unknown');
  });

  test('fail closed: an unreadable request is refused rather than reported as "nothing stale"', () => {
    for (const bad of [null, { cases: 'x', rulesHashes: {} }, { cases: [], rulesHashes: [] }, { cases: [null], rulesHashes: {} }]) {
      const result = staleCases(bad);
      expect(result.ok).toBe(false);
      expect(result.stale).toEqual([]);
      expect(result.reason).toBeTruthy();
    }
  });
});

describe('final-gate fixes: fail-closed comparison and confirmation', () => {
  const run = (entries) => ({ cases: entries.map(([id, found]) => ({ id, found })) });

  test('two empty runs are not ok and make no pass claim', () => {
    const result = compareEval({ previous: run([]), current: run([]) });
    expect(result.ok).toBe(false);
    expect(result.regression).toBe(true);
    expect(result.reason).toBe('no-cases');
  });

  test('a run with a duplicate case id is invalid and names the id', () => {
    const result = compareEval({ previous: run([['a', true]]), current: run([['a', false], ['a', true]]) });
    expect(result.ok).toBe(false);
    expect(result.regression).toBe(true);
    expect(result.reason).toContain('a');
    expect(result.reason).toContain('duplicate');
  });

  test('scoreEval marks an unconfirmed case case-unconfirmed when CODEOWNERS is supplied', () => {
    const cases = [evalCase(), evalCase({ id: 'case-002', confirmedBy: '@docs-owner' })];
    const findingsByCase = { 'case-001': [finding()], 'case-002': [finding()] };
    const result = scoreEval({ cases, findingsByCase, codeowners: CODEOWNERS });
    expect(result.cases[0].found).toBe(true);
    expect(result.cases[1]).toMatchObject({ id: 'case-002', found: false, reason: 'case-unconfirmed' });
    expect(result.total.found).toBe(1);
  });
});
