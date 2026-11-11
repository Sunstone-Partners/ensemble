'use strict';

/**
 * TRD-042-TEST: Cohort comparison and guardrail (PRD scenarios).
 *
 * Validates PRD ACs: AC-019-3, AC-019-4 (REQ-019).
 *
 * The Implementation AC tests for `compareCohorts` live in
 * pr-review-cohort-compare.test.js, metric by metric. These are the
 * PRD-LEVEL scenarios, read the way the requirement states them: TWO real
 * cohorts, each at least 20 PRs and at least 30 days, compared in ONE call,
 * with every target named by the acceptance criterion checked on the SAME
 * result rather than assembled test by test.
 *
 * Scenarios:
 *   - AC-019-3: a post-change cohort and the baseline cohort, each of at
 *     least 20 PRs and at least 30 days, are compared and every target is
 *     expressed relative to baseline: median human approvals and p95 human
 *     wait down, rounds-to-pass down by at least 30%, PRs needing five or
 *     more rounds down by at least 50%, and noise rate down by at least 30%.
 *   - AC-019-4: when the cohort's revert or incident counts exceed baseline,
 *     the report marks the cohort as failing the guardrail REGARDLESS of
 *     every other result -- including a cohort that met every target.
 *
 * Each scenario also carries the case that must be REFUSED (a cohort that
 * improved too little; a guardrail that cannot be checked), so neither
 * passes only in the trivial direction.
 */

const { compareCohorts, COHORT_MINIMUMS } = require('../lib/pr-review-metrics');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-02-01T00:00:00Z');

/**
 * `count` merged PRs spread evenly over `spanDays`. Each PR gets `rounds`
 * CHANGES_REQUESTED reviews (one commit answers each, which is what
 * rounds-to-pass counts), `approvals` human approvals, and `waitHours`
 * before the first human responds.
 */
function prs({ count, spanDays, rounds, approvals, waitHours, titlePrefix = 'feat' }) {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const day = (index * spanDays) / (count - 1);
    const opened = T0 + day * DAY;
    const reviews = [];
    const commits = [{ committedDate: new Date(opened + HOUR / 2).toISOString() }];
    for (let round = 0; round < rounds; round += 1) {
      reviews.push({
        author: { login: 'a-human' },
        state: 'CHANGES_REQUESTED',
        submittedAt: new Date(opened + waitHours * HOUR + round * 2 * HOUR).toISOString(),
        body: 'please change this',
      });
      commits.push({ committedDate: new Date(opened + waitHours * HOUR + round * 2 * HOUR + HOUR).toISOString() });
    }
    for (let approval = 0; approval < approvals; approval += 1) {
      reviews.push({
        author: { login: `approver-${approval}` },
        state: 'APPROVED',
        submittedAt: new Date(opened + (waitHours + rounds * 2 + 1) * HOUR).toISOString(),
        body: 'looks good',
      });
    }
    list.push({
      number: index + 1,
      title: `${titlePrefix}: change ${index + 1}`,
      author: { login: 'author-one' },
      createdAt: new Date(opened).toISOString(),
      mergedAt: new Date(opened + 72 * HOUR).toISOString(),
      reviews,
      comments: [],
      commits,
    });
  }
  return list;
}

/** `response` entries whose noise share is exactly `noise` out of `total` findings. */
function findingResponses(total, noise) {
  const responses = [];
  for (let index = 0; index < total; index += 1) {
    responses.push({ findingId: `f-${index}`, response: index < noise ? 'wrong' : 'fixed' });
  }
  return responses;
}

/** The baseline cohort both scenarios compare against: 24 PRs over 60 days, slow and noisy. */
const BASELINE = {
  prs: prs({ count: 24, spanDays: 60, rounds: 6, approvals: 2, waitHours: 20 }),
  findingResponses: findingResponses(100, 40),
  revertCommitsOnDefaultBranch: 3,
  incidents: 2,
};

/** The post-change cohort: same size and span, every measure improved past its target. */
const IMPROVED = {
  prs: prs({ count: 24, spanDays: 60, rounds: 2, approvals: 1, waitHours: 4 }),
  findingResponses: findingResponses(100, 10),
  revertCommitsOnDefaultBranch: 1,
  incidents: 0,
};

const targetById = (result, id) => result.targets.find((target) => target.id === id);

describe('Scenario AC-019-3: two sufficient cohorts compared, every target expressed relative to baseline', () => {
  test('one compareCohorts call grades median approvals, p95 wait, rounds-to-pass, the 5+-round share and noise against the baseline', () => {
    const result = compareCohorts({ baseline: BASELINE, current: IMPROVED });

    expect(result.ok).toBe(true);
    // Both cohorts clear the stated floor: at least 20 PRs and at least 30 days.
    expect(COHORT_MINIMUMS).toEqual({ prs: 20, days: 30 });
    expect(result.insufficient).toEqual([]);
    expect(result.cohortOk).toBe(true);

    // Median human approvals: simply lower than baseline.
    const approvals = targetById(result, 'human-approvals-median');
    expect(approvals.current).toBeLessThan(approvals.baseline);
    expect(approvals.met).toBe(true);

    // p95 wait on a human: simply lower than baseline.
    const wait = targetById(result, 'wait-on-human-p95');
    expect(wait.current).toBeLessThan(wait.baseline);
    expect(wait.met).toBe(true);

    // Rounds-to-pass: at least 30% lower.
    const rounds = targetById(result, 'rounds-to-pass');
    expect(rounds.requiredReduction).toBe(0.3);
    expect(rounds.achievedReduction).toBeGreaterThanOrEqual(0.3);
    expect(rounds.met).toBe(true);

    // PRs needing five or more rounds: at least 50% lower.
    const fivePlus = targetById(result, 'prs-needing-5-plus-rounds');
    expect(fivePlus.requiredReduction).toBe(0.5);
    expect(fivePlus.achievedReduction).toBeGreaterThanOrEqual(0.5);
    expect(fivePlus.met).toBe(true);

    // Noise rate: at least 30% lower.
    const noise = targetById(result, 'noise-rate');
    expect(noise.requiredReduction).toBe(0.3);
    expect(noise.baseline).toBeCloseTo(0.4, 10);
    expect(noise.current).toBeCloseTo(0.1, 10);
    expect(noise.achievedReduction).toBeGreaterThanOrEqual(0.3);
    expect(noise.met).toBe(true);

    expect(result.targets.map((target) => target.id).sort()).toEqual([
      'human-approvals-median',
      'noise-rate',
      'prs-needing-5-plus-rounds',
      'rounds-to-pass',
      'wait-on-human-p95',
    ]);
    expect(result.targetsMet).toBe(true);
    expect(result.guardrail).toBe('passed');
    expect(result.met).toBe(true);
  });

  test('the case that must be refused: a cohort that improved, but by less than the stated reductions, is not met', () => {
    // Rounds 6 -> 5 is a 16% reduction, noise 40% -> 35% is 12.5%: real
    // movement, below every required size. "Better" is not the target.
    const tooLittle = {
      prs: prs({ count: 24, spanDays: 60, rounds: 5, approvals: 1, waitHours: 4 }),
      findingResponses: findingResponses(100, 35),
      revertCommitsOnDefaultBranch: 1,
      incidents: 0,
    };

    const result = compareCohorts({ baseline: BASELINE, current: tooLittle });

    expect(result.ok).toBe(true);
    expect(result.cohortOk).toBe(true);
    expect(targetById(result, 'rounds-to-pass').met).toBe(false);
    expect(targetById(result, 'noise-rate').met).toBe(false);
    expect(result.targetsMet).toBe(false);
    expect(result.met).toBe(false);
  });

  test('the second case that must be refused: a cohort of 12 PRs over 14 days is rejected before any target is graded', () => {
    const thin = {
      prs: prs({ count: 12, spanDays: 14, rounds: 1, approvals: 0, waitHours: 1 }),
      findingResponses: findingResponses(100, 0),
      revertCommitsOnDefaultBranch: 0,
      incidents: 0,
    };

    const result = compareCohorts({ baseline: BASELINE, current: thin });

    expect(result.ok).toBe(true);
    expect(result.cohortOk).toBe(false);
    expect(result.insufficient.map((entry) => entry.side)).toEqual(['current']);
    expect(result.insufficient[0].reason).toBe('fewer-than-20-prs');
    expect(result.targets).toEqual([]);
    expect(result.targetsMet).toBe(false);
    expect(result.met).toBe(false);
  });
});

describe('Scenario AC-019-4: more reverts or incidents than baseline fails the guardrail whatever else the cohort achieved', () => {
  test('a cohort that met every target still fails when revert commits rose above baseline', () => {
    const regressed = { ...IMPROVED, revertCommitsOnDefaultBranch: 4 };

    const result = compareCohorts({ baseline: BASELINE, current: regressed });

    expect(result.ok).toBe(true);
    // Every target still met -- the guardrail is what decides.
    expect(result.targetsMet).toBe(true);
    expect(result.guardrail).toBe('failed');
    expect(result.guardrailBreaches).toEqual([
      { metric: 'revertCommitsOnDefaultBranch', baseline: 3, current: 4 },
    ]);
    expect(result.met).toBe(false);
  });

  test('a cohort that met every target still fails when incidents rose above baseline', () => {
    const regressed = { ...IMPROVED, incidents: 3 };

    const result = compareCohorts({ baseline: BASELINE, current: regressed });

    expect(result.targetsMet).toBe(true);
    expect(result.guardrail).toBe('failed');
    expect(result.guardrailBreaches).toEqual([{ metric: 'incidents', baseline: 2, current: 3 }]);
    expect(result.met).toBe(false);
  });

  test('revert PRs inside the cohort count too: more Revert-titled PRs than baseline fails the guardrail', () => {
    const regressed = {
      ...IMPROVED,
      prs: [
        ...IMPROVED.prs,
        ...prs({ count: 2, spanDays: 1, rounds: 1, approvals: 1, waitHours: 1, titlePrefix: 'Revert' }),
      ],
    };

    const result = compareCohorts({ baseline: BASELINE, current: regressed });

    expect(result.guardrailBreaches.map((breach) => breach.metric)).toContain('revertPrsInCohort');
    expect(result.guardrail).toBe('failed');
    expect(result.met).toBe(false);
  });

  test('the case that must be refused: a guardrail nobody can check is reported unknown, never as a pass', () => {
    const noIncidentCount = { ...IMPROVED };
    delete noIncidentCount.incidents;

    const result = compareCohorts({ baseline: BASELINE, current: noIncidentCount });

    expect(result.targetsMet).toBe(true);
    expect(result.guardrail).toBe('unknown');
    expect(result.guardrailUnknown).toEqual([{ metric: 'incidents', baseline: 2, current: null }]);
    expect(result.met).toBe(false);
  });

  test('the guardrail is evaluated even when the cohort is too thin to certify any target', () => {
    const thinAndWorse = {
      prs: prs({ count: 8, spanDays: 10, rounds: 1, approvals: 0, waitHours: 1 }),
      findingResponses: findingResponses(10, 0),
      revertCommitsOnDefaultBranch: 9,
      incidents: 9,
    };

    const result = compareCohorts({ baseline: BASELINE, current: thinAndWorse });

    expect(result.cohortOk).toBe(false);
    expect(result.guardrail).toBe('failed');
    expect(result.met).toBe(false);
  });
});
