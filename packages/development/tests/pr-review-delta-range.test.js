'use strict';

/**
 * TRD-011: Delta-review range with unvouched fallback (`pr-review-scope.js`).
 *
 * Validates PRD ACs: AC-010-1, AC-010-3 (REQ-010). These are the
 * Implementation AC tests; the PRD-scenario tests live in TRD-011-TEST.
 *
 * What is pinned here:
 *   1. after the first round, with a previously reviewed head and readable
 *      commit facts, the range to review is `lastReviewedSha..headSha` -- the
 *      changes since the last review and nothing else (AC-010-1);
 *   2. a merge commit in that range, a commit the review-state report does
 *      not record as a remediation commit, or a parent chain that does not
 *      reach the reviewed head, each send the review back to the FULL
 *      base-correct range with reason `unvouched-history` (AC-010-3);
 *   3. a reviewed head that is unknown, malformed or unreachable falls back
 *      to the full range and never guesses one.
 *
 * Fail closed: every answer this module cannot justify is MORE review (the
 * full range), never less. There is no input for which it returns a delta it
 * cannot vouch for.
 */

const { chooseReviewRange } = require('../lib/pr-review-scope');

const BASE = '8b87a6d71146cd2e36e09c4fc265b6bb336f8798';
const REVIEWED = '914369d8ebedb871a1f1f619f3ad410f48350642';
const FIX_1 = '2aa6fdf7dda287fe5b6212acb2e01a1c7ec4def7';
const FIX_2 = 'fc339eb496cd68ecab4ccab79cdcc65c540fd20c';
const HEAD = 'b8fe66aeb70b304237e584311a2b481a3c990f91';
const OTHER = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607';

/** head -> FIX_2 -> FIX_1 -> reviewed: an ordinary remediation push. */
const LINEAR_COMMITS = [
  { sha: FIX_2, parents: [FIX_1] },
  { sha: FIX_1, parents: [REVIEWED] },
];

function delta(overrides = {}) {
  return {
    baseSha: BASE,
    headSha: FIX_2,
    lastReviewedSha: REVIEWED,
    commits: LINEAR_COMMITS,
    remediationShas: [FIX_1, FIX_2],
    ...overrides,
  };
}

describe('TRD-011 AC-010-1: after the first round, only the changes since the last review', () => {
  test('a vouched-for push is reviewed as lastReviewed..head', () => {
    const result = chooseReviewRange(delta());

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('delta');
    expect(result.range).toBe(`${REVIEWED}..${FIX_2}`);
    expect(result.reason).toBe('delta-since-last-review');
    expect(result.unvouched).toEqual([]);
  });

  test('the full base-correct range is always reported alongside, so a caller can widen', () => {
    const result = chooseReviewRange(delta());
    expect(result.fullRange).toBe(`${BASE}..${FIX_2}`);
    expect(result.baseSha).toBe(BASE);
  });

  test('the first round has no reviewed head, so it reviews the full range', () => {
    const result = chooseReviewRange({ baseSha: BASE, headSha: HEAD });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('full');
    expect(result.range).toBe(`${BASE}..${HEAD}`);
    expect(result.reason).toBe('first-round');
  });

  test('a head that has not moved since the review is an empty delta, not a re-review', () => {
    const result = chooseReviewRange({ baseSha: BASE, headSha: REVIEWED, lastReviewedSha: REVIEWED, commits: [], remediationShas: [] });

    expect(result.mode).toBe('delta');
    expect(result.reason).toBe('head-unchanged');
    expect(result.range).toBe(`${REVIEWED}..${REVIEWED}`);
  });

  test('the base is resolved by the same rules as the full scope: a stacked parent tip wins', () => {
    const result = chooseReviewRange({
      parentPhaseTipSha: OTHER,
      baseSha: BASE,
      headSha: FIX_2,
      lastReviewedSha: REVIEWED,
      commits: LINEAR_COMMITS,
      remediationShas: [FIX_1, FIX_2],
    });

    expect(result.baseSha).toBe(OTHER);
    expect(result.fullRange).toBe(`${OTHER}..${FIX_2}`);
    expect(result.mode).toBe('delta');
  });
});

describe('TRD-011 AC-010-3: history the system cannot vouch for forces a full re-review', () => {
  test('a merge commit in the range is unvouched', () => {
    const result = chooseReviewRange(
      delta({
        commits: [
          { sha: FIX_2, parents: [FIX_1, OTHER] },
          { sha: FIX_1, parents: [REVIEWED] },
        ],
      })
    );

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('unvouched-history');
    expect(result.range).toBe(`${BASE}..${FIX_2}`);
    expect(result.unvouched).toContainEqual({ sha: FIX_2, reason: 'merge-commit' });
  });

  test('a commit the review state does not record as remediation is unvouched (an agent push)', () => {
    const result = chooseReviewRange(delta({ remediationShas: [FIX_1] }));

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('unvouched-history');
    expect(result.unvouched).toContainEqual({ sha: FIX_2, reason: 'not-a-recorded-remediation-commit' });
  });

  test('a parent chain that does not reach the reviewed head is unvouched (a rebase or a reset)', () => {
    const result = chooseReviewRange(
      delta({
        commits: [
          { sha: FIX_2, parents: [FIX_1] },
          { sha: FIX_1, parents: [OTHER] },
        ],
      })
    );

    expect(result.mode).toBe('full');
    expect(result.unvouched).toContainEqual({ sha: FIX_1, reason: 'history-does-not-reach-reviewed-head' });
  });

  test('a commit handed in that is not on the chain from the head is unvouched', () => {
    const result = chooseReviewRange(
      delta({
        commits: [...LINEAR_COMMITS, { sha: OTHER, parents: [REVIEWED] }],
        remediationShas: [FIX_1, FIX_2, OTHER],
      })
    );

    expect(result.mode).toBe('full');
    expect(result.unvouched).toContainEqual({ sha: OTHER, reason: 'not-on-the-reviewed-chain' });
  });

  test('every unvouched commit is named, not just the first', () => {
    const result = chooseReviewRange(
      delta({
        commits: [
          { sha: FIX_2, parents: [FIX_1, OTHER] },
          { sha: FIX_1, parents: [REVIEWED] },
        ],
        remediationShas: [],
      })
    );

    expect(result.unvouched.map((entry) => entry.sha).sort()).toEqual([FIX_1, FIX_2].sort());
  });
});

describe('TRD-011: an unknown or unreachable reviewed head falls back, never guesses', () => {
  test('a reviewed head that is not a full object id is not read as a reviewed head', () => {
    for (const bad of ['HEAD', 'main', '914369d', 42, {}, []]) {
      const result = chooseReviewRange(delta({ lastReviewedSha: bad }));
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('reviewed-head-unknown');
      expect(result.range).toBe(`${BASE}..${FIX_2}`);
    }
  });

  test('a delta with no commit facts is refused as a delta: unknown history is never vouched for', () => {
    const noFacts = chooseReviewRange({ baseSha: BASE, headSha: FIX_2, lastReviewedSha: REVIEWED });
    expect(noFacts.mode).toBe('full');
    expect(noFacts.reason).toBe('commit-facts-unavailable');

    for (const commits of ['all of them', {}, [null], [{ sha: FIX_2 }], [{ sha: FIX_2, parents: 'none' }]]) {
      const result = chooseReviewRange(delta({ commits }));
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('commit-facts-unreadable');
    }
  });

  test('an unreadable remediation list is not an empty one', () => {
    for (const remediationShas of ['none', {}, [null], [42]]) {
      const result = chooseReviewRange(delta({ remediationShas }));
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('remediation-record-unreadable');
    }
  });

  test('a head that is reachable from no commit in the range is unvouched, never a silent delta', () => {
    const result = chooseReviewRange(delta({ commits: [{ sha: FIX_1, parents: [REVIEWED] }], remediationShas: [FIX_1] }));
    expect(result.mode).toBe('full');
    expect(result.unvouched).toContainEqual({ sha: FIX_2, reason: 'head-commit-missing-from-history' });
  });

  test('a request that cannot be read blocks: no range is invented', () => {
    for (const bad of [null, undefined, 'full', 7, [], {}, { headSha: HEAD }, { baseSha: BASE }]) {
      const result = chooseReviewRange(bad);
      expect(result.ok).toBe(false);
      expect(result.status).toBe('REVIEW_BLOCKED');
      expect(result.range).toBeUndefined();
    }
  });

  test('a malformed base or head blocks rather than producing half a range', () => {
    expect(chooseReviewRange({ baseSha: 'main', headSha: HEAD }).ok).toBe(false);
    expect(chooseReviewRange({ baseSha: BASE, headSha: 'HEAD' }).ok).toBe(false);
  });
});
