'use strict';

/**
 * Local-CI baseline and cycle-time reporting (REQ-013).
 *
 * Pure functions, no network, no side effects: the caller supplies PR timings
 * already fetched (see skills/local-ci-gate/BASELINE.md for the capture
 * procedure).
 *
 * A PR timing is
 *   { number?, openedAt, mergedAt, ciWaitMs?, botReviewWaitMs? }
 * where openedAt/mergedAt are ISO-8601 strings (or epoch ms) and the two wait
 * fields are non-negative millisecond durations attributable to hosted CI and
 * to bot review respectively. Open-to-merge is mergedAt - openedAt.
 *
 * Percentiles use linear interpolation between closest ranks (the common
 * "type 7" definition): position = p * (n - 1) over the sorted values.
 * median = p50, p75 = p75.
 *
 * FAIL CLOSED. A PR whose open/merge times are missing, unparseable or
 * out of order is rejected (listed in `rejected`, never counted). A wait that
 * is missing or invalid is left out of THAT wait's series only; it is never
 * read as zero. Status is `met` only when every condition for it is proven;
 * missing or malformed input yields `unproven`.
 */

function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function validWait(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Linear-interpolation percentile; p in [0,1]. Returns null for no data. */
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(values) {
  return {
    count: values.length,
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
  };
}

/** Summarise a cohort window of PR timings. */
function summarizeCohort(prs) {
  const rejected = [];
  const openToMerge = [];
  const ciWait = [];
  const botReviewWait = [];
  const list = Array.isArray(prs) ? prs : [];
  list.forEach((pr, index) => {
    const id = pr && typeof pr === 'object' && pr.number !== undefined ? pr.number : index;
    if (pr === null || typeof pr !== 'object') {
      rejected.push({ id, reason: 'entry is not an object' });
      return;
    }
    const opened = toMs(pr.openedAt);
    const merged = toMs(pr.mergedAt);
    if (opened === null || merged === null) {
      rejected.push({ id, reason: 'missing or unparseable openedAt/mergedAt' });
      return;
    }
    if (merged < opened) {
      rejected.push({ id, reason: 'mergedAt precedes openedAt' });
      return;
    }
    openToMerge.push(merged - opened);
    if (validWait(pr.ciWaitMs)) ciWait.push(pr.ciWaitMs);
    if (validWait(pr.botReviewWaitMs)) botReviewWait.push(pr.botReviewWaitMs);
  });
  return {
    count: openToMerge.length,
    openToMerge: stats(openToMerge),
    ciWait: stats(ciWait),
    botReviewWait: stats(botReviewWait),
    rejected,
  };
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Report whether the cycle-time target is met.
 *
 * options: {
 *   baseline: PR timings (cohort before the gate was enabled),
 *   postChange: PR timings (cohort after enablement),
 *   minPostChangeCohort: positive integer, decided from the baseline,
 *   targetReduction: number in (0,1], fraction by which BOTH median and p75
 *     open-to-merge must fall versus baseline, decided from the baseline,
 * }
 * Returns { status: 'met'|'not-met'|'unproven', reason, baseline, postChange }.
 * `met` requires: a usable baseline, a valid minimum and target, at least the
 * minimum number of valid post-change PRs, and both median and p75 reduced by
 * at least the target. Anything missing or below the minimum is `unproven`.
 */
function reportStatus(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const baseline = summarizeCohort(opts.baseline);
  const postChange = summarizeCohort(opts.postChange);
  const result = (status, reason) => ({ status, reason, baseline, postChange });

  if (baseline.count === 0) return result('unproven', 'no valid baseline cohort');
  if (!positiveInt(opts.minPostChangeCohort)) {
    return result('unproven', 'minimum post-change cohort size is not decided');
  }
  const target = opts.targetReduction;
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0 || target > 1) {
    return result('unproven', 'numeric target is not decided');
  }
  if (postChange.count < opts.minPostChangeCohort) {
    return result(
      'unproven',
      `insufficient post-change data: ${postChange.count} < ${opts.minPostChangeCohort}`
    );
  }
  const bm = baseline.openToMerge;
  const pm = postChange.openToMerge;
  if (!(bm.median > 0) || !(bm.p75 > 0)) {
    return result('unproven', 'baseline open-to-merge is zero; reduction cannot be computed');
  }
  const medianReduction = 1 - pm.median / bm.median;
  const p75Reduction = 1 - pm.p75 / bm.p75;
  if (medianReduction >= target && p75Reduction >= target) {
    return result('met', 'median and p75 reductions meet the target');
  }
  return result('not-met', 'median or p75 reduction is below the target');
}

module.exports = { percentile, summarizeCohort, reportStatus };
