'use strict';

/**
 * TRD-042: Cohort comparison and the revert/incident guardrail
 * (`pr-review-metrics.js`).
 *
 * Validates PRD ACs: AC-019-3, AC-019-4 (REQ-019). These are the
 * Implementation AC tests; the PRD-scenario tests live in TRD-042-TEST.
 *
 * What is pinned here:
 *   1. a cohort under 20 PRs or under 30 days is REJECTED as insufficient --
 *      a six-PR week never certifies a review change (AC-019-3);
 *   2. every target is expressed RELATIVE TO BASELINE: rounds-to-pass at
 *      least 30% lower, PRs needing 5+ rounds at least 50% lower, noise at
 *      least 30% lower, median human approvals and p95 human wait simply
 *      lower (AC-019-3);
 *   3. any increase in reverts or incidents over baseline fails the guardrail
 *      regardless of every other result (AC-019-4), and a guardrail that
 *      cannot be checked is never reported as passed;
 *   4. the per-tier breakdown rides along for both cohorts, with untiered
 *      records grouped and nothing failing.
 *
 * FAIL CLOSED is the property under test throughout: a missing number, an
 * unreadable cohort or an unverifiable guardrail must never produce "met".
 */

const path = require('path');

const { computeMetrics, compareCohorts, COHORT_MINIMUMS } = require('../lib/pr-review-metrics');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-01-01T00:00:00Z');

/**
 * A cohort of `count` PRs spread over `spanDays`, each with `rounds` fix
 * rounds and `approvals` human approvals. Enough to drive the comparison
 * without pretending to be real GitHub data.
 */
function cohort({ count = 20, spanDays = 40, rounds = 2, approvals = 1, author = 'author-one', titlePrefix = 'feat' } = {}) {
  const prs = [];
  for (let index = 0; index < count; index += 1) {
    const day = count === 1 ? 0 : (index * spanDays) / (count - 1);
    const reviews = [];
    for (let round = 0; round < rounds; round += 1) {
      reviews.push({ author: { login: 'a-human' }, state: 'CHANGES_REQUESTED', submittedAt: new Date(T0 + day * DAY + round * HOUR).toISOString(), body: 'please change this' });
    }
    for (let approval = 0; approval < approvals; approval += 1) {
      reviews.push({ author: { login: `approver-${approval}` }, state: 'APPROVED', submittedAt: new Date(T0 + day * DAY + (rounds + 1) * HOUR).toISOString(), body: 'looks good' });
    }
    const commits = [];
    for (let round = 0; round <= rounds; round += 1) {
      commits.push({ committedDate: new Date(T0 + day * DAY + (round + 1) * HOUR + HOUR / 2).toISOString() });
    }
    prs.push({
      number: index + 1,
      title: `${titlePrefix}: change ${index + 1}`,
      author: { login: author },
      createdAt: new Date(T0 + day * DAY).toISOString(),
      mergedAt: new Date(T0 + day * DAY + 48 * HOUR).toISOString(),
      reviews,
      comments: [],
      commits,
    });
  }
  return prs;
}

/** `computeMetrics` over a generated cohort, with the extra cohort facts a comparison needs. */
function metricsFor(options = {}, extras = {}) {
  const result = computeMetrics({ prs: cohort(options), ...extras });
  expect(result.ok).toBe(true);
  return result;
}

describe('TRD-042 AC-019-3: a cohort too small or too short is rejected, never compared', () => {
  test('the minimums are the REQ-019 rule: 20 PRs and 30 days', () => {
    expect(COHORT_MINIMUMS).toEqual({ prs: 20, days: 30 });
  });

  test('a current cohort of 6 PRs is insufficient and no target is reported as met', () => {
    const result = compareCohorts({
      baseline: metricsFor({ count: 25, rounds: 4 }),
      current: metricsFor({ count: 6, spanDays: 40, rounds: 1 }),
    });

    expect(result.ok).toBe(true);
    expect(result.cohortOk).toBe(false);
    expect(result.met).toBe(false);
    expect(result.insufficient).toEqual([{ side: 'current', reason: 'fewer-than-20-prs', prCount: 6, spanDays: 40 }]);
    expect(result.targets).toEqual([]);
  });

  test('a 20-PR cohort spanning 12 days is insufficient too, and says which rule it missed', () => {
    const result = compareCohorts({
      baseline: metricsFor({ count: 25, rounds: 4 }),
      current: metricsFor({ count: 20, spanDays: 12, rounds: 1 }),
    });

    expect(result.cohortOk).toBe(false);
    expect(result.insufficient).toEqual([{ side: 'current', reason: 'shorter-than-30-days', prCount: 20, spanDays: 12 }]);
  });

  test('an insufficient BASELINE is rejected as well: a change is never certified against a thin baseline', () => {
    const result = compareCohorts({
      baseline: metricsFor({ count: 8, spanDays: 40, rounds: 4 }),
      current: metricsFor({ count: 25, rounds: 1 }),
    });

    expect(result.cohortOk).toBe(false);
    expect(result.insufficient.map((entry) => entry.side)).toEqual(['baseline']);
    expect(result.met).toBe(false);
  });

  test('both cohorts at the minimum are sufficient: the rule is at least, not more than', () => {
    const result = compareCohorts({
      baseline: metricsFor({ count: 20, spanDays: 30, rounds: 4 }),
      current: metricsFor({ count: 20, spanDays: 30, rounds: 1 }),
    });

    expect(result.cohortOk).toBe(true);
    expect(result.insufficient).toEqual([]);
  });
});

describe('TRD-042 AC-019-3: every target is relative to baseline, with its own required reduction', () => {
  const baseline = () =>
    computeMetrics({
      prs: cohort({ count: 25, spanDays: 40, rounds: 4, approvals: 2 }),
      findingResponses: [
        { findingId: 'f1', response: 'fixed' },
        { findingId: 'f2', response: 'wrong' },
        { findingId: 'f3', response: 'intentional' },
        { findingId: 'f4', response: 'unimportant' },
        { findingId: 'f5', response: 'fixed' },
      ],
      revertCommitsOnDefaultBranch: 2,
      incidents: 1,
    });

  test('the five targets are named with their required reductions', () => {
    const result = compareCohorts({ baseline: baseline(), current: baseline() });

    expect(result.targets.map((target) => [target.id, target.requiredReduction])).toEqual([
      ['rounds-to-pass', 0.3],
      ['prs-needing-5-plus-rounds', 0.5],
      ['noise-rate', 0.3],
      ['human-approvals-median', null],
      ['wait-on-human-p95', null],
    ]);
  });

  test('an identical cohort improves nothing: equal is not lower', () => {
    const result = compareCohorts({ baseline: baseline(), current: baseline() });

    // Every target that HAD something to reduce is unmet; one already at zero
    // is held at zero, which is named rather than counted as an improvement.
    const improvable = result.targets.filter((target) => target.baseline !== 0);
    expect(improvable.length).toBeGreaterThan(0);
    expect(improvable.every((target) => target.met === false)).toBe(true);
    expect(result.targets.filter((target) => target.met).every((target) => target.reason === 'baseline-is-zero-held-at-zero')).toBe(true);
    expect(result.met).toBe(false);
  });

  test('rounds-to-pass needs a 30% reduction: 25% short is not met, 50% is', () => {
    const base = computeMetrics({ prs: cohort({ count: 25, rounds: 4 }) });
    const short = computeMetrics({ prs: cohort({ count: 25, rounds: 3 }) }); // 4 -> 3 is 25%
    const enough = computeMetrics({ prs: cohort({ count: 25, rounds: 2 }) }); // 4 -> 2 is 50%

    const shortTarget = compareCohorts({ baseline: base, current: short }).targets.find((target) => target.id === 'rounds-to-pass');
    const metTarget = compareCohorts({ baseline: base, current: enough }).targets.find((target) => target.id === 'rounds-to-pass');

    expect([shortTarget.baseline, shortTarget.current, shortTarget.achievedReduction, shortTarget.met]).toEqual([4, 3, 0.25, false]);
    expect([metTarget.baseline, metTarget.current, metTarget.achievedReduction, metTarget.met]).toEqual([4, 2, 0.5, true]);
  });

  test('the 5-plus-round share needs 50%: a 40% cut is refused', () => {
    // 10 of 20 PRs need 5+ rounds at baseline; 6 of 20 after (a 40% cut).
    const withShare = (heavy, total) =>
      computeMetrics({ prs: [...cohort({ count: heavy, spanDays: 40, rounds: 5 }), ...cohort({ count: total - heavy, spanDays: 40, rounds: 1 })] });

    const target = compareCohorts({ baseline: withShare(10, 20), current: withShare(6, 20) }).targets.find(
      (entry) => entry.id === 'prs-needing-5-plus-rounds'
    );

    expect(target.achievedReduction).toBeCloseTo(0.4, 10);
    expect(target.met).toBe(false);

    const better = compareCohorts({ baseline: withShare(10, 20), current: withShare(5, 20) }).targets.find(
      (entry) => entry.id === 'prs-needing-5-plus-rounds'
    );
    expect(better.met).toBe(true);
  });

  test('noise needs 30%: the rate comes from the author responses, never from an estimate', () => {
    const responses = (noise, fixed) => [
      ...Array.from({ length: noise }, (unused, index) => ({ findingId: `n${index}`, response: 'wrong' })),
      ...Array.from({ length: fixed }, (unused, index) => ({ findingId: `f${index}`, response: 'fixed' })),
    ];
    const base = computeMetrics({ prs: cohort({ count: 25 }), findingResponses: responses(5, 5) }); // 0.5
    const after = computeMetrics({ prs: cohort({ count: 25 }), findingResponses: responses(3, 7) }); // 0.3

    const target = compareCohorts({ baseline: base, current: after }).targets.find((entry) => entry.id === 'noise-rate');
    expect([target.baseline, target.current]).toEqual([0.5, 0.3]);
    expect(target.achievedReduction).toBeCloseTo(0.4, 10);
    expect(target.met).toBe(true);
  });

  test('a target whose baseline number was never measured is not met, and says why', () => {
    const base = computeMetrics({ prs: cohort({ count: 25 }) }); // no findingResponses: noise is null with a reason
    const after = computeMetrics({ prs: cohort({ count: 25 }), findingResponses: [{ findingId: 'f1', response: 'fixed' }] });

    const target = compareCohorts({ baseline: base, current: after }).targets.find((entry) => entry.id === 'noise-rate');
    expect(target.met).toBe(false);
    expect(target.reason).toBe('baseline-value-unavailable');
  });

  test('a baseline of zero cannot be reduced: only a current of zero holds, anything above it is worse', () => {
    // No reviews at all, so no fix round was ever needed: the baseline is 0.
    const base = computeMetrics({ prs: cohort({ count: 25, rounds: 0, approvals: 0 }) });
    const same = computeMetrics({ prs: cohort({ count: 25, rounds: 0, approvals: 0 }) });
    const worse = computeMetrics({ prs: cohort({ count: 25, rounds: 2 }) });

    const held = compareCohorts({ baseline: base, current: same }).targets.find((entry) => entry.id === 'rounds-to-pass');
    expect([held.met, held.reason]).toEqual([true, 'baseline-is-zero-held-at-zero']);

    const regressed = compareCohorts({ baseline: base, current: worse }).targets.find((entry) => entry.id === 'rounds-to-pass');
    expect([regressed.met, regressed.reason]).toEqual([false, 'baseline-is-zero-current-is-higher']);
  });

  test('met is true only when every target is met and the guardrail passed', () => {
    const base = computeMetrics({
      prs: cohort({ count: 25, spanDays: 40, rounds: 4, approvals: 2 }),
      findingResponses: [{ findingId: 'a', response: 'wrong' }, { findingId: 'b', response: 'fixed' }],
      revertCommitsOnDefaultBranch: 3,
      incidents: 2,
    });
    const after = computeMetrics({
      prs: cohort({ count: 25, spanDays: 40, rounds: 1, approvals: 1 }),
      findingResponses: [{ findingId: 'a', response: 'fixed' }, { findingId: 'b', response: 'fixed' }, { findingId: 'c', response: 'fixed' }],
      revertCommitsOnDefaultBranch: 1,
      incidents: 0,
    });

    const result = compareCohorts({ baseline: base, current: after });
    expect(result.targets.filter((target) => !target.met)).toEqual([]);
    expect(result.guardrail).toBe('passed');
    expect(result.met).toBe(true);
  });
});

describe('TRD-042 AC-019-4: any increase in reverts or incidents fails the guardrail, whatever else happened', () => {
  /** A cohort that meets every target, so only the guardrail can decide the outcome. */
  const improved = (extras) =>
    computeMetrics({
      prs: cohort({ count: 25, spanDays: 40, rounds: 1, approvals: 1 }),
      findingResponses: [{ findingId: 'a', response: 'fixed' }, { findingId: 'b', response: 'fixed' }],
      ...extras,
    });
  const before = (extras) =>
    computeMetrics({
      prs: cohort({ count: 25, spanDays: 40, rounds: 4, approvals: 2 }),
      findingResponses: [{ findingId: 'a', response: 'wrong' }, { findingId: 'b', response: 'fixed' }],
      ...extras,
    });

  test('one more revert commit fails the guardrail even with every target met', () => {
    const result = compareCohorts({
      baseline: before({ revertCommitsOnDefaultBranch: 1, incidents: 0 }),
      current: improved({ revertCommitsOnDefaultBranch: 2, incidents: 0 }),
    });

    expect(result.targets.filter((target) => !target.met)).toEqual([]);
    expect(result.guardrail).toBe('failed');
    expect(result.guardrailBreaches).toEqual([
      { metric: 'revertCommitsOnDefaultBranch', baseline: 1, current: 2 },
    ]);
    expect(result.met).toBe(false);
  });

  test('one more incident fails it the same way', () => {
    const result = compareCohorts({
      baseline: before({ revertCommitsOnDefaultBranch: 0, incidents: 1 }),
      current: improved({ revertCommitsOnDefaultBranch: 0, incidents: 3 }),
    });

    expect(result.guardrail).toBe('failed');
    expect(result.guardrailBreaches).toEqual([{ metric: 'incidents', baseline: 1, current: 3 }]);
    expect(result.met).toBe(false);
  });

  test('a revert PR that appeared in the cohort itself counts too', () => {
    const baselineResult = computeMetrics({ prs: cohort({ count: 25, spanDays: 40, rounds: 4 }), revertCommitsOnDefaultBranch: 0, incidents: 0 });
    const currentResult = computeMetrics({
      prs: [...cohort({ count: 24, spanDays: 40, rounds: 1 }), ...cohort({ count: 1, spanDays: 40, rounds: 1, titlePrefix: 'Revert' })],
      revertCommitsOnDefaultBranch: 0,
      incidents: 0,
    });

    const result = compareCohorts({ baseline: baselineResult, current: currentResult });
    expect(result.guardrail).toBe('failed');
    expect(result.guardrailBreaches).toEqual([{ metric: 'revertPrsInCohort', baseline: 0, current: 1 }]);
  });

  test('equal counts pass the guardrail, and fewer pass it too', () => {
    const equal = compareCohorts({
      baseline: before({ revertCommitsOnDefaultBranch: 2, incidents: 1 }),
      current: improved({ revertCommitsOnDefaultBranch: 2, incidents: 1 }),
    });
    const fewer = compareCohorts({
      baseline: before({ revertCommitsOnDefaultBranch: 2, incidents: 1 }),
      current: improved({ revertCommitsOnDefaultBranch: 0, incidents: 0 }),
    });

    expect([equal.guardrail, fewer.guardrail]).toEqual(['passed', 'passed']);
    expect(equal.guardrailBreaches).toEqual([]);
  });

  test('a guardrail nobody can check is never passed: an absent count is unknown, and the cohort does not pass', () => {
    const result = compareCohorts({
      baseline: before({ revertCommitsOnDefaultBranch: 1 }), // no incident count on either side
      current: improved({ revertCommitsOnDefaultBranch: 0 }),
    });

    expect(result.guardrail).toBe('unknown');
    expect(result.guardrailUnknown).toEqual([{ metric: 'incidents', baseline: null, current: null }]);
    expect(result.met).toBe(false);
    expect(result.targetsMet).toBe(true);
  });

  test('the guardrail is evaluated even when the cohort is too small, because a revert is a fact either way', () => {
    const result = compareCohorts({
      baseline: before({ revertCommitsOnDefaultBranch: 0, incidents: 0 }),
      current: computeMetrics({ prs: cohort({ count: 5, spanDays: 40, rounds: 1 }), revertCommitsOnDefaultBranch: 4, incidents: 0 }),
    });

    expect(result.cohortOk).toBe(false);
    expect(result.guardrail).toBe('failed');
    expect(result.met).toBe(false);
  });
});

describe('TRD-042: the comparison reads a committed baseline file as well as a computed cohort', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
  const baselineFile = require(path.join(REPO_ROOT, 'docs/guides/review-baseline-2026-10-27.json'));

  test('the committed baseline file is accepted directly, with its snake_case field names', () => {
    const current = computeMetrics({
      prs: cohort({ count: 25, spanDays: 40, rounds: 0, approvals: 1 }),
      revertCommitsOnDefaultBranch: 0,
      incidents: 0,
    });

    const result = compareCohorts({ baseline: baselineFile, current });
    expect(result.ok).toBe(true);
    expect(result.cohortOk).toBe(true);
    expect(result.targets.find((target) => target.id === 'rounds-to-pass').baseline).toBe(
      baselineFile.metrics.rounds_to_pass.median
    );
  });

  test('a raw cohort input is computed on the spot, so a caller need not call metrics first', () => {
    const fromRaw = compareCohorts({
      baseline: { prs: cohort({ count: 25, spanDays: 40, rounds: 4 }) },
      current: { prs: cohort({ count: 25, spanDays: 40, rounds: 1 }) },
    });
    const fromComputed = compareCohorts({
      baseline: computeMetrics({ prs: cohort({ count: 25, spanDays: 40, rounds: 4 }) }),
      current: computeMetrics({ prs: cohort({ count: 25, spanDays: 40, rounds: 1 }) }),
    });

    expect(fromRaw.targets).toEqual(fromComputed.targets);
  });

  test('the per-tier breakdown of both cohorts rides along, untiered records grouped, nothing failing', () => {
    const tiered = (tier) => cohort({ count: 10, spanDays: 40, rounds: 1 }).map((record) => ({ ...record, tier }));
    const mixed = [...tiered('High'), ...tiered('medium'), ...cohort({ count: 5, spanDays: 40, rounds: 1 })];

    const result = compareCohorts({
      baseline: computeMetrics({ prs: cohort({ count: 25, spanDays: 40, rounds: 4 }) }),
      current: computeMetrics({ prs: mixed }),
    });

    expect(result.ok).toBe(true);
    expect(result.byTier.current.map((bucket) => [bucket.tier, bucket.prs])).toEqual([
      ['high', 10],
      ['medium', 10],
      ['untiered', 5],
    ]);
    expect(result.byTier.baseline.map((bucket) => bucket.tier)).toEqual(['untiered']);
  });
});

describe('TRD-042: fail closed -- nothing unreadable is ever a passing comparison', () => {
  test.each([null, undefined, [], 'x', 5, true, false, {}, { baseline: {} }, { current: {} }])(
    'compareCohorts(%p) is refused, with no targets and no passing guardrail',
    (input) => {
      const result = compareCohorts(input);
      expect(result.ok).toBe(false);
      expect(result.met).toBe(false);
      expect(result.targets).toEqual([]);
      expect(result.guardrail).not.toBe('passed');
      expect(typeof result.reason).toBe('string');
    }
  );

  test('a cohort the metrics module itself refused is refused here, naming the side', () => {
    const result = compareCohorts({
      baseline: { prs: 'all of them' },
      current: computeMetrics({ prs: cohort({ count: 25 }) }),
    });

    expect(result.ok).toBe(false);
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/baseline/);
  });

  test('a baseline whose metrics are not an object is refused, never read as zeros', () => {
    const result = compareCohorts({
      baseline: { cohort: { prCount: 25, spanDays: 40 }, metrics: 'none' },
      current: computeMetrics({ prs: cohort({ count: 25 }) }),
    });

    expect(result.ok).toBe(false);
    expect(result.met).toBe(false);
  });
});
