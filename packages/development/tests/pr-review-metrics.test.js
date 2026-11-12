'use strict';

/**
 * TRD-030: Per-cohort review metrics (`pr-review-metrics.js`).
 *
 * Validates PRD ACs: AC-019-1, AC-019-2 (REQ-019). These are the
 * Implementation AC tests; the PRD-scenario tests live in TRD-030-TEST.
 *
 * What is pinned here:
 *   1. human approvals per PR (median and p95), human comments, wait-on-human
 *      hours, rounds-to-pass and the share needing five or more rounds, all
 *      counting ONLY non-bot reviewers (AC-019-1);
 *   2. the noise rate is (wrong + intentional + unimportant) / presented, and
 *      is `null` WITH A REASON when no author-response records exist -- never
 *      zero, never an estimate (AC-019-2);
 *   3. the library reproduces the COMMITTED baseline
 *      `docs/guides/review-baseline-2026-10-27.json` exactly from the same
 *      inputs: the real merged PRs of this repository, fetched with the
 *      runbook's own `gh` query. That check is the one that proves the
 *      library and the runbook measure the same thing.
 *
 * The live reproduction check needs `gh` logged in, because its input is real
 * GitHub data that this repository deliberately does not vendor. When `gh` is
 * unavailable the check reports loudly that it did not run -- it never passes
 * quietly -- and the surrounding assertions on the committed baseline and the
 * runbook still run.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { computeMetrics, checkAgainstBaseline, median, percentile, DEFAULT_BOTS } = require('../lib/pr-review-metrics');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'docs/guides/review-baseline-2026-10-27.json');

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

describe('TRD-030 AC-019-1: per-cohort metrics counting only non-bot reviewers', () => {
  test('human approvals per PR are reported as median and p95, with bots excluded', () => {
    const result = computeMetrics({
      prs: [
        pr({ number: 1, reviews: [review('a-human', 2, 'APPROVED'), review('coderabbitai', 1, 'APPROVED')] }),
        pr({ number: 2, reviews: [review('github-actions', 2, 'APPROVED')] }),
        pr({ number: 3, reviews: [review('a-human', 2, 'APPROVED'), review('another-human', 3, 'APPROVED')] }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.metrics.humanApprovalsPerPr).toEqual({ median: 1, p95: 2, prsWithAny: 2 });
  });

  test('an approval by the PR author never counts', () => {
    const result = computeMetrics({ prs: [pr({ reviews: [review('author-one', 1, 'APPROVED')] })] });
    expect(result.metrics.humanApprovalsPerPr.prsWithAny).toBe(0);
  });

  test('a `[bot]` suffix or an `app/` prefix is a bot even when it is not on the list', () => {
    const result = computeMetrics({
      prs: [pr({ reviews: [review('some-new-thing[bot]', 1, 'APPROVED'), review('app/integration', 2, 'APPROVED')] })],
    });
    expect(result.metrics.humanApprovalsPerPr.prsWithAny).toBe(0);
    expect(DEFAULT_BOTS).toContain('coderabbitai');
  });

  test('human comments count issue comments and review bodies, never empty ones', () => {
    const result = computeMetrics({
      prs: [
        pr({
          reviews: [review('a-human', 2, 'COMMENTED', 'a real remark'), review('a-human', 3, 'APPROVED', '')],
          comments: [
            { author: { login: 'a-human' }, createdAt: at(4), body: 'one more' },
            { author: { login: 'a-human' }, createdAt: at(5), body: '' },
            { author: { login: 'coderabbitai' }, createdAt: at(6), body: 'bot summary' },
            { author: { login: 'author-one' }, createdAt: at(7), body: 'my own note' },
          ],
        }),
      ],
    });

    expect(result.metrics.humanComments).toEqual({ total: 2, medianPerPr: 2, p95PerPr: 2, prsWithAny: 1 });
  });

  test('wait-on-human is measured to the first human response, and PRs with none are counted apart', () => {
    const result = computeMetrics({
      prs: [
        pr({ number: 1, reviews: [review('a-human', 10)] }),
        pr({ number: 2, reviews: [review('coderabbitai', 1)], comments: [{ author: { login: 'a-human' }, createdAt: at(4), body: 'hi' }] }),
        pr({ number: 3, reviews: [review('coderabbitai', 1)] }),
      ],
    });

    expect(result.metrics.waitOnHumanHours.median).toBe(7);
    expect(result.metrics.waitOnHumanHours.prsWithHumanResponse).toBe(2);
    // A PR nobody answered has NO wait: it is never entered as a zero.
    expect(result.metrics.waitOnHumanHours.prsWithNoHumanResponse).toBe(1);
  });

  test('rounds-to-pass counts reviews that were followed by a commit before the next review or the merge', () => {
    const result = computeMetrics({
      prs: [
        pr({
          number: 1,
          reviews: [review('a-human', 2), review('a-human', 10)],
          commits: [{ committedDate: at(1) }, { committedDate: at(5) }, { committedDate: at(20) }],
          mergedAt: at(30),
        }),
        pr({ number: 2, reviews: [review('a-human', 2)], commits: [{ committedDate: at(1) }], mergedAt: at(5) }),
      ],
    });

    // PR 1: both reviews were acted on. PR 2: the only commit predates the review.
    expect(result.metrics.roundsToPass.max).toBe(2);
    expect(result.metrics.roundsToPass.median).toBe(1);
    expect(result.metrics.roundsToPass.mean).toBe(1);
  });

  test('the share needing five or more rounds is reported as a count and a share', () => {
    const busy = pr({
      number: 1,
      reviews: [review('a-human', 1), review('a-human', 3), review('a-human', 5), review('a-human', 7), review('a-human', 9)],
      commits: [2, 4, 6, 8, 10].map((hours) => ({ committedDate: at(hours) })),
      mergedAt: at(12),
    });

    const result = computeMetrics({ prs: [busy, pr({ number: 2 })] });
    expect(result.metrics.shareNeeding5PlusRounds).toEqual({ count: 1, share: 0.5 });
  });

  test('a per-tier breakdown is included, and records with no tier are grouped as untiered', () => {
    const result = computeMetrics({
      prs: [
        pr({ number: 1, tier: 'high', reviews: [review('a-human', 1, 'APPROVED')] }),
        pr({ number: 2, tier: 'high', reviews: [review('a-human', 1, 'APPROVED')] }),
        pr({ number: 3 }),
      ],
    });

    expect(result.metrics.byTier.map((bucket) => [bucket.tier, bucket.prs])).toEqual([
      ['high', 2],
      ['untiered', 1],
    ]);
  });

  test('the cohort rule is reported, never enforced silently', () => {
    const small = computeMetrics({ prs: [pr()] });
    expect(small.cohort.meetsMinPrs).toBe(false);
    expect(small.cohort.meetsMinSpanDays).toBe(false);
    expect(small.ok).toBe(true);
  });

  test('median and percentile follow the runbook: averaged middle, nearest-rank p95', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
    expect(percentile([0, 0, 0, 1], 95)).toBe(1);
  });

  test('fail closed: a request it cannot read is refused, never an empty report', () => {
    for (const bad of [null, undefined, 'prs', 7, [], {}, { prs: {} }, { prs: [null] }, { prs: [{}] }]) {
      const result = computeMetrics(bad);
      expect(result.ok).toBe(false);
      expect(result.metrics).toBeNull();
    }
  });
});

describe('TRD-030 AC-019-2: the noise rate, and what is never invented', () => {
  const responses = (classes) => classes.map((response, index) => ({ findingId: `F${index}`, response }));

  test('noise is (wrong + intentional + unimportant) / presented', () => {
    const result = computeMetrics({
      prs: [pr()],
      findingResponses: responses(['fixed', 'fixed', 'wrong', 'intentional', 'unimportant']),
    });

    expect(result.metrics.noiseRate.value).toBe(0.6);
    expect(result.metrics.noiseRate.counts).toEqual({ fixed: 2, wrong: 1, intentional: 1, unimportant: 1, unclassified: 0 });
    expect(result.metrics.noiseRate.presented).toBe(5);
  });

  test('a cohort whose findings were all fixed has a noise rate of zero -- a real number, not a null', () => {
    const result = computeMetrics({ prs: [pr()], findingResponses: responses(['fixed', 'fixed']) });
    expect(result.metrics.noiseRate.value).toBe(0);
  });

  test('with no response records at all the rate is null WITH A REASON, never zero', () => {
    const result = computeMetrics({ prs: [pr()] });
    expect(result.metrics.noiseRate.value).toBeNull();
    expect(result.metrics.noiseRate.reason).toMatch(/not estimated/);
  });

  test('an unrecognised response class is counted and named, never folded into fixed or noise', () => {
    const result = computeMetrics({ prs: [pr()], findingResponses: responses(['fixed', 'shrugged', 'wrong']) });

    expect(result.metrics.noiseRate.counts.unclassified).toBe(1);
    expect(result.metrics.noiseRate.value).toBeCloseTo(1 / 3, 10);
    expect(result.metrics.noiseRate.reason).toMatch(/no recognised class/);
  });

  test('incidents and default-branch reverts are reported only when supplied', () => {
    const withNothing = computeMetrics({ prs: [pr({ title: 'Revert "feat: a change"' })] });
    expect(withNothing.metrics.incidents).toEqual({ value: null, reason: expect.stringMatching(/never asserted/) });
    expect(withNothing.metrics.reverts).toEqual({ revertPrsInCohort: 1, revertCommitsOnDefaultBranch: null });

    const withCounts = computeMetrics({ prs: [pr()], incidents: 0, revertCommitsOnDefaultBranch: 3 });
    expect(withCounts.metrics.incidents.value).toBe(0);
    expect(withCounts.metrics.reverts.revertCommitsOnDefaultBranch).toBe(3);
  });
});

describe('TRD-030 AC-019-1: the library reproduces the committed baseline exactly', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  /**
   * The runbook's own cohort query, bounded to the cohort the baseline captured.
   * Merged PRs keep accumulating, so an unbounded query stops matching the
   * committed numbers the day after the baseline is written; only PRs created
   * on or before the baseline's latest creation date belong to it.
   * Returns null when gh cannot answer.
   */
  function fetchCohort() {
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    } catch (err) {
      return null;
    }
    const cutoff = Date.parse(baseline.cohort.latest_created_at);
    const numbers = JSON.parse(
      execFileSync('gh', ['pr', 'list', '--repo', baseline.repository, '--state', 'merged', '--limit', '1000', '--json', 'number,createdAt'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    )
      .filter((entry) => Date.parse(entry.createdAt) <= cutoff)
      .map((entry) => entry.number);

    return numbers.map((number) =>
      JSON.parse(
        execFileSync(
          'gh',
          ['pr', 'view', String(number), '--repo', baseline.repository, '--json', 'number,title,author,createdAt,mergedAt,reviews,comments,commits'],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
        )
      )
    );
  }

  test('the committed baseline is a reportable cohort and records how it was captured', () => {
    expect(baseline.cohort.pr_count).toBeGreaterThanOrEqual(20);
    expect(baseline.cohort.span_days).toBeGreaterThanOrEqual(30);
    expect(baseline.cohort.meets_min_prs).toBe(true);
    expect(baseline.cohort.meets_min_span_days).toBe(true);
    expect(baseline.cohort.note).toMatch(/\S/);
    expect(baseline.bots).toEqual(DEFAULT_BOTS.slice());
  });

  test('the baseline reports what it could not measure rather than inventing it', () => {
    expect(baseline.metrics.noise_rate_by_author_response_class.value).toBeNull();
    expect(baseline.metrics.noise_rate_by_author_response_class.reason).toMatch(/\S/);
    expect(baseline.metrics.incidents.value).toBeNull();
  });

  test('computeMetrics reproduces every committed baseline number from the same real PRs (needs gh)', () => {
    const prs = fetchCohort();
    if (prs === null) {
      // Loud, not silent: the one check that ties this library to the runbook
      // did not run here, and this says so.
      // eslint-disable-next-line no-console
      console.warn(
        'SKIPPED the baseline-reproduction check: `gh auth status` failed, so the real merged-PR data behind '
          + `${path.relative(REPO_ROOT, BASELINE_PATH)} could not be fetched. Run this suite with gh logged in to verify it.`
      );
      expect(fs.existsSync(BASELINE_PATH)).toBe(true);
      return;
    }

    const computed = computeMetrics({ prs, revertCommitsOnDefaultBranch: baseline.metrics.reverts.revert_commits_on_default_branch });
    expect(computed.ok).toBe(true);

    const check = checkAgainstBaseline({ baseline, metrics: computed.metrics, cohort: computed.cohort });
    expect(check.mismatches).toEqual([]);
    expect(check.reproduces).toBe(true);
  }, 600000);

  test('checkAgainstBaseline names every number that differs, and refuses what it cannot read', () => {
    const computed = computeMetrics({ prs: [pr()] });
    const check = checkAgainstBaseline({ baseline, metrics: computed.metrics, cohort: computed.cohort });

    expect(check.ok).toBe(true);
    expect(check.reproduces).toBe(false);
    expect(check.mismatches.map((entry) => entry.field)).toContain('cohort.pr_count');

    for (const bad of [null, undefined, {}, { baseline: {}, metrics: {}, cohort: {} }, { baseline, metrics: null, cohort: null }]) {
      expect(checkAgainstBaseline(bad).ok).toBe(false);
    }
  });
});
