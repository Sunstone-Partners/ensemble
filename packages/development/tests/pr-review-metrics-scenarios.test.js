'use strict';

/**
 * TRD-030-TEST: Cohort metrics (PRD scenarios).
 *
 * Validates PRD ACs: AC-019-1, AC-019-2 (REQ-019).
 *
 * The Implementation AC tests for the module live in pr-review-metrics.test.js
 * (which also proves `computeMetrics` reproduces the real committed baseline
 * from real `gh`-fetched PRs -- the strongest reproduction check this
 * library has). These are the PRD-LEVEL scenarios, read the way the
 * requirement states them: one cohort, one call, every measure named in the
 * acceptance criterion checked on the SAME result, not assembled test by
 * test.
 *
 * Scenarios:
 *   - AC-019-1: a cohort of merged PRs produces human approvals per PR
 *     (median and p95), human comments, wait-on-human time, rounds-to-pass
 *     and the share of PRs needing five or more rounds -- all in one report.
 *   - AC-019-2: findings presented to authors are classified by response
 *     (fixed, said wrong, said intentional, judged unimportant) and a noise
 *     rate is reported from that classification.
 */

const { computeMetrics } = require('../lib/pr-review-metrics');

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (hours) => new Date(T0 + hours * HOUR).toISOString();

function pr(overrides = {}) {
  return {
    number: 1,
    title: 'feat: a change',
    author: { login: 'author-one' },
    createdAt: at(0),
    mergedAt: at(48),
    reviews: [],
    comments: [],
    commits: [{ committedDate: at(1) }],
    ...overrides,
  };
}

const review = (login, hours, state = 'COMMENTED', body = 'please change this') => ({
  author: { login },
  state,
  submittedAt: at(hours),
  body,
});

describe('Scenario AC-019-1: a cohort of merged PRs reports human approvals, comments, wait time, rounds-to-pass and the 5+-round share', () => {
  test('one computeMetrics call over a real-shaped cohort answers every measure the acceptance criterion names', () => {
    const quiet = pr({
      number: 1,
      reviews: [review('a-human', 2, 'APPROVED')],
      comments: [{ author: { login: 'a-human' }, body: 'lgtm', createdAt: at(2) }],
    });
    const busy = pr({
      number: 2,
      reviews: [
        review('a-human', 1),
        review('a-human', 3),
        review('a-human', 5),
        review('a-human', 7),
        review('a-human', 9, 'APPROVED'),
      ],
      commits: [2, 4, 6, 8, 10].map((hours) => ({ committedDate: at(hours) })),
      mergedAt: at(12),
    });

    const result = computeMetrics({ prs: [quiet, busy] });

    expect(result.ok).toBe(true);
    // Human approvals per PR (median and p95).
    expect(result.metrics.humanApprovalsPerPr.median).toBe(1);
    expect(result.metrics.humanApprovalsPerPr.p95).toBeGreaterThanOrEqual(1);
    // Human comments.
    expect(result.metrics.humanComments.total).toBeGreaterThanOrEqual(1);
    // Wait-on-human time (to the first human response).
    expect(result.metrics.waitOnHumanHours.median).toBeGreaterThan(0);
    // Rounds-to-pass.
    expect(result.metrics.roundsToPass.max).toBeGreaterThanOrEqual(1);
    // The share of PRs needing five or more rounds.
    expect(result.metrics.shareNeeding5PlusRounds).toEqual({ count: 1, share: 0.5 });
  });
});

describe('Scenario AC-019-2: findings presented are classified by author response, and a noise rate is reported', () => {
  test('fixed, said-wrong, said-intentional and judged-unimportant are each counted, and the noise rate follows them', () => {
    const result = computeMetrics({
      prs: [pr()],
      findingResponses: [
        { findingId: 'F1', response: 'fixed' },
        { findingId: 'F2', response: 'fixed' },
        { findingId: 'F3', response: 'wrong' },
        { findingId: 'F4', response: 'intentional' },
        { findingId: 'F5', response: 'unimportant' },
      ],
    });

    expect(result.metrics.noiseRate.counts).toEqual({
      fixed: 2,
      wrong: 1,
      intentional: 1,
      unimportant: 1,
      unclassified: 0,
    });
    // noise = (wrong + intentional + unimportant) / presented = 3 / 5.
    expect(result.metrics.noiseRate.value).toBe(0.6);
    expect(result.metrics.noiseRate.presented).toBe(5);
  });

  test('with no findings presented at all the noise rate is null with a reason, never an invented zero', () => {
    const result = computeMetrics({ prs: [pr()] });
    expect(result.metrics.noiseRate.value).toBeNull();
    expect(result.metrics.noiseRate.reason).toMatch(/not estimated/);
  });
});
