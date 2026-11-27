'use strict';

/**
 * Per-cohort review metrics and cohort comparison (TRD-030 and TRD-042,
 * REQ-019).
 *
 * NO side effects, NO shell, NO network, NO file reads. A pure function over
 * the merged-PR records a maintainer collects with `gh` (the capture in
 * `docs/guides/pr-review-cycle-time-pilot.md` §6.3), in exactly the shape
 * `gh pr view --json number,title,author,createdAt,mergedAt,reviews,comments,commits`
 * returns.
 *
 * This module is the LIBRARY HALF of a measurement whose definitions live in
 * that runbook, which is prose a maintainer edits. It is checked against the
 * runbook: given the same PR records, `computeMetrics` reproduces the
 * committed `docs/guides/review-baseline-<date>.json` exactly (AC-019-1,
 * checked in TRD-030's tests against the real baseline and the real cohort).
 *
 * WHAT IS NEVER INVENTED. A metric with no data is `null` WITH A REASON, not
 * zero and not an estimate:
 *   - the noise rate needs per-finding records carrying the author's response
 *     class; with none, `value` is null and the reason says so;
 *   - a PR that never got a human response has no wait, so it is COUNTED
 *     SEPARATELY rather than entered as a zero wait;
 *   - incidents need a tracker; this module reports what it was given and
 *     nothing else.
 *
 * FAIL CLOSED: a request this module cannot read is refused with a reason.
 * There is no input for which it answers "no problems found".
 *
 * `compareCohorts` (TRD-042) adds the second half of REQ-019: it compares a
 * post-change cohort with the baseline, expresses every target RELATIVE to
 * that baseline (AC-019-3), and fails the whole comparison on any increase in
 * reverts or incidents (AC-019-4). It invents nothing either: a cohort under
 * 20 PRs or 30 days is rejected instead of compared, a target whose baseline
 * number was never measured is not met, and a guardrail that cannot be
 * checked is `unknown` -- never `passed`.
 */

/** The default bot list, matching the runbook's `bots` definition. A caller may pass its own. */
const DEFAULT_BOTS = Object.freeze([
  'github-actions',
  'coderabbitai',
  'dependabot',
  'copilot-pull-request-reviewer',
  'renovate',
]);

/** The author-response classes that count as noise (AC-019-2). */
const NOISE_CLASSES = Object.freeze(['wrong', 'intentional', 'unimportant']);
const RESPONSE_CLASSES = Object.freeze(['fixed', ...NOISE_CLASSES]);

/** A cohort must be at least this big and this long to be reportable (REQ-019 cohort rule). */
const COHORT_MINIMUMS = Object.freeze({ prs: 20, days: 30 });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

function failure(reason) {
  return { ok: false, reason, cohort: null, metrics: null };
}

/** An ISO timestamp as epoch seconds, or null when it cannot be read. */
function seconds(value) {
  if (!isText(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

/** The runbook's definition of a human: not in the bot list, no `[bot]` suffix, no `app/` prefix. */
function isHuman(login, bots) {
  if (!isText(login)) return false;
  const name = login.trim();
  return !bots.includes(name) && !name.endsWith('[bot]') && !name.startsWith('app/');
}

/** The median of the readable numbers, or null when there are none. The runbook's `median`. */
function median(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The nearest-rank percentile the runbook uses: ceil(p * n / 100), 1-indexed. */
function percentile(values, p) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.floor((p * sorted.length + 99) / 100) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

function mean(values) {
  const readable = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (readable.length === 0) return null;
  return readable.reduce((sum, value) => sum + value, 0) / readable.length;
}

/** The author's login, however the record spells it. */
function authorLogin(record) {
  return isObject(record) && isObject(record.author) && isText(record.author.login) ? record.author.login : null;
}

const listOf = (value) => (Array.isArray(value) ? value.filter(isObject) : []);

/** Reviews by a human who is not the PR's author. */
function humanReviews(pr, bots) {
  const author = authorLogin(pr);
  return listOf(pr.reviews).filter((review) => {
    const login = authorLogin(review);
    return isHuman(login, bots) && login !== author;
  });
}

/**
 * Human comments: non-empty issue comments plus non-empty review bodies, by
 * anyone but the author.
 */
function humanCommentCount(pr, bots) {
  const author = authorLogin(pr);
  const comments = listOf(pr.comments).filter((comment) => {
    const login = authorLogin(comment);
    return isHuman(login, bots) && login !== author && isText(comment.body);
  });
  const reviewBodies = humanReviews(pr, bots).filter((review) => isText(review.body));
  return comments.length + reviewBodies.length;
}

/** Hours from PR creation to the first human response, or null when none ever came. */
function waitOnHumanHours(pr, bots) {
  const opened = seconds(pr.createdAt);
  if (opened === null) return null;
  const author = authorLogin(pr);

  const responses = [
    ...humanReviews(pr, bots)
      .filter((review) => isText(review.submittedAt))
      .map((review) => seconds(review.submittedAt)),
    ...listOf(pr.comments)
      .filter((comment) => {
        const login = authorLogin(comment);
        return isHuman(login, bots) && login !== author;
      })
      .map((comment) => seconds(comment.createdAt)),
  ].filter((value) => value !== null);

  if (responses.length === 0) return null;
  return (Math.min(...responses) - opened) / 3600;
}

/**
 * Fix rounds: a review that was acted on -- a review with at least one commit
 * after it and before the next review (or the merge, for the last review).
 * Bot reviews count here, unlike the human-only metrics: a round is work the
 * author did, whoever asked for it.
 */
function fixRounds(pr) {
  const author = authorLogin(pr);
  const mergedAt = seconds(pr.mergedAt);
  const reviews = listOf(pr.reviews)
    .filter((review) => isText(review.submittedAt) && (author === null || authorLogin(review) !== author))
    .map((review) => seconds(review.submittedAt))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const commits = listOf(pr.commits)
    .map((commit) => seconds(commit.committedDate))
    .filter((value) => value !== null);

  return reviews.filter((review, index) => {
    const until = index + 1 < reviews.length ? reviews[index + 1] : mergedAt;
    return commits.some((commit) => commit > review && (until === null || commit < until));
  }).length;
}

/**
 * The noise rate (AC-019-2): (wrong + intentional + unimportant) / presented.
 *
 * `null` with a reason when no response records were supplied -- historical
 * PRs carry none, and a hand-classified estimate is not a measurement.
 */
function noiseRate(responses) {
  if (responses === undefined || responses === null) {
    return {
      value: null,
      reason: 'no per-finding author-response records were supplied; the noise rate is not estimated',
      counts: null,
      presented: 0,
    };
  }
  if (!Array.isArray(responses) || !responses.every(isObject)) {
    return { value: null, reason: 'author-response records must be an array of objects', counts: null, presented: 0 };
  }

  const counts = { fixed: 0, wrong: 0, intentional: 0, unimportant: 0, unclassified: 0 };
  for (const record of responses) {
    const response = isText(record.response) ? record.response.trim().toLowerCase() : null;
    if (response !== null && RESPONSE_CLASSES.includes(response)) counts[response] += 1;
    else counts.unclassified += 1;
  }

  const presented = responses.length;
  if (presented === 0) {
    return { value: null, reason: 'no findings were presented in this cohort', counts, presented };
  }
  // An unclassified response is NOT quietly treated as a real finding or as
  // noise: it is counted and named, and the rate says how many it covers.
  const noisy = NOISE_CLASSES.reduce((sum, name) => sum + counts[name], 0);
  const result = { value: noisy / presented, reason: null, counts, presented };
  if (counts.unclassified > 0) {
    result.reason = `${counts.unclassified} of ${presented} responses carry no recognised class and are counted as neither fixed nor noise`;
  }
  return result;
}

/** The per-tier breakdown: records with no tier are grouped as `untiered`, and nothing fails. */
function tierOf(pr) {
  return isText(pr.tier) ? pr.tier.trim().toLowerCase() : 'untiered';
}

/**
 * Computes the review metrics for one cohort of merged PRs (AC-019-1,
 * AC-019-2).
 *
 * @param {Object} input
 * @param {Object[]} input.prs        `gh pr view` records for the cohort.
 * @param {string[]} [input.bots]     Bot logins; defaults to the runbook's list.
 * @param {Object[]} [input.findingResponses]  `[{ findingId?, response }]` with
 *   `response` in fixed | wrong | intentional | unimportant.
 * @param {number} [input.revertCommitsOnDefaultBranch]  Counted outside this module (git log).
 * @param {number} [input.incidents]  From an incident tracker; omitted means none exists.
 * @returns {{ok:boolean, reason?:string, cohort:Object|null, metrics:Object|null}}
 */
function computeMetrics(input) {
  if (!isObject(input)) return failure('invalid-input');
  const { prs } = input;
  if (!Array.isArray(prs)) return failure('prs must be an array');
  if (!prs.every(isObject)) return failure('prs must contain only PR records');

  const bots = Array.isArray(input.bots) && input.bots.every(isText)
    ? input.bots.map((login) => login.trim())
    : DEFAULT_BOTS.slice();

  const created = prs.map((pr) => seconds(pr.createdAt));
  if (created.some((value) => value === null)) return failure('every PR record needs a readable createdAt');

  const approvals = prs.map((pr) => humanReviews(pr, bots).filter((review) => review.state === 'APPROVED').length);
  const comments = prs.map((pr) => humanCommentCount(pr, bots));
  const waits = prs.map((pr) => waitOnHumanHours(pr, bots));
  const rounds = prs.map((pr) => fixRounds(pr));
  const answered = waits.filter((wait) => wait !== null);

  const spanDays = prs.length === 0 ? 0 : Math.floor((Math.max(...created) - Math.min(...created)) / 86400);
  const fivePlus = rounds.filter((count) => count >= 5).length;

  const byTier = new Map();
  prs.forEach((pr, index) => {
    const tier = tierOf(pr);
    if (!byTier.has(tier)) byTier.set(tier, { tier, prs: 0, approvals: [], rounds: [], waits: [] });
    const bucket = byTier.get(tier);
    bucket.prs += 1;
    bucket.approvals.push(approvals[index]);
    bucket.rounds.push(rounds[index]);
    bucket.waits.push(waits[index]);
  });

  const cohort = {
    prCount: prs.length,
    earliestCreatedAt: prs.length === 0 ? null : prs.map((pr) => pr.createdAt).sort()[0],
    latestCreatedAt: prs.length === 0 ? null : prs.map((pr) => pr.createdAt).sort()[prs.length - 1],
    spanDays,
    meetsMinPrs: prs.length >= COHORT_MINIMUMS.prs,
    meetsMinSpanDays: spanDays >= COHORT_MINIMUMS.days,
    bots,
  };

  const metrics = {
    humanApprovalsPerPr: { median: median(approvals), p95: percentile(approvals, 95), prsWithAny: approvals.filter((count) => count > 0).length },
    humanComments: {
      total: comments.reduce((sum, count) => sum + count, 0),
      medianPerPr: median(comments),
      p95PerPr: percentile(comments, 95),
      prsWithAny: comments.filter((count) => count > 0).length,
    },
    waitOnHumanHours: {
      median: median(answered),
      p95: percentile(answered, 95),
      prsWithHumanResponse: answered.length,
      prsWithNoHumanResponse: waits.length - answered.length,
    },
    roundsToPass: {
      median: median(rounds),
      p95: percentile(rounds, 95),
      mean: mean(rounds),
      max: rounds.length === 0 ? null : Math.max(...rounds),
      prsCommitDataTruncated: prs.filter((pr) => listOf(pr.commits).length >= 100).map((pr) => pr.number),
    },
    shareNeeding5PlusRounds: { count: fivePlus, share: prs.length === 0 ? null : fivePlus / prs.length },
    noiseRate: noiseRate(input.findingResponses),
    reverts: {
      revertPrsInCohort: prs.filter((pr) => isText(pr.title) && pr.title.trim().startsWith('Revert')).length,
      revertCommitsOnDefaultBranch: Number.isInteger(input.revertCommitsOnDefaultBranch) ? input.revertCommitsOnDefaultBranch : null,
    },
    incidents: Number.isInteger(input.incidents)
      ? { value: input.incidents, reason: null }
      : { value: null, reason: 'no incident count was supplied; it is never asserted' },
    byTier: [...byTier.values()]
      .sort((a, b) => (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0))
      .map((bucket) => ({
        tier: bucket.tier,
        prs: bucket.prs,
        humanApprovalsMedian: median(bucket.approvals),
        roundsMedian: median(bucket.rounds),
        waitHoursMedian: median(bucket.waits.filter((wait) => wait !== null)),
      })),
  };

  return { ok: true, cohort, metrics };
}

/** Numbers equal to the precision a committed baseline is written at. */
function sameNumber(left, right) {
  if (left === null || right === null) return left === right;
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  return Math.abs(left - right) < 1e-9;
}

/**
 * Checks a computed result against a committed baseline file (AC-019-1): the
 * library must reproduce the runbook's numbers EXACTLY from the same inputs.
 *
 * @param {{baseline:Object, metrics:Object, cohort:Object}} input  `baseline` is the
 *   parsed `docs/guides/review-baseline-<date>.json`; `metrics` and `cohort` come
 *   from `computeMetrics`.
 * @returns {{ok:boolean, reproduces:boolean, mismatches:Array<{field:string, baseline:*, computed:*}>, reason?:string}}
 */
function checkAgainstBaseline(input) {
  if (!isObject(input)) return { ok: false, reproduces: false, mismatches: [], reason: 'invalid-input' };
  const { baseline, metrics, cohort } = input;
  if (!isObject(baseline) || !isObject(baseline.metrics) || !isObject(baseline.cohort)) {
    return { ok: false, reproduces: false, mismatches: [], reason: 'baseline must carry cohort and metrics' };
  }
  if (!isObject(metrics) || !isObject(cohort)) {
    return { ok: false, reproduces: false, mismatches: [], reason: 'metrics and cohort are required' };
  }

  const b = baseline.metrics;
  const checks = [
    ['cohort.pr_count', baseline.cohort.pr_count, cohort.prCount],
    ['cohort.span_days', baseline.cohort.span_days, cohort.spanDays],
    ['human_approvals_per_pr.median', b.human_approvals_per_pr.median, metrics.humanApprovalsPerPr.median],
    ['human_approvals_per_pr.p95', b.human_approvals_per_pr.p95, metrics.humanApprovalsPerPr.p95],
    ['human_approvals_per_pr.prs_with_any', b.human_approvals_per_pr.prs_with_any, metrics.humanApprovalsPerPr.prsWithAny],
    ['human_comments.total', b.human_comments.total, metrics.humanComments.total],
    ['human_comments.median_per_pr', b.human_comments.median_per_pr, metrics.humanComments.medianPerPr],
    ['human_comments.p95_per_pr', b.human_comments.p95_per_pr, metrics.humanComments.p95PerPr],
    ['human_comments.prs_with_any', b.human_comments.prs_with_any, metrics.humanComments.prsWithAny],
    ['wait_on_human_hours.median', b.wait_on_human_hours.median, metrics.waitOnHumanHours.median],
    ['wait_on_human_hours.p95', b.wait_on_human_hours.p95, metrics.waitOnHumanHours.p95],
    ['wait_on_human_hours.prs_with_human_response', b.wait_on_human_hours.prs_with_human_response, metrics.waitOnHumanHours.prsWithHumanResponse],
    ['wait_on_human_hours.prs_with_no_human_response', b.wait_on_human_hours.prs_with_no_human_response, metrics.waitOnHumanHours.prsWithNoHumanResponse],
    ['rounds_to_pass.median', b.rounds_to_pass.median, metrics.roundsToPass.median],
    ['rounds_to_pass.p95', b.rounds_to_pass.p95, metrics.roundsToPass.p95],
    ['rounds_to_pass.mean', b.rounds_to_pass.mean, metrics.roundsToPass.mean],
    ['rounds_to_pass.max', b.rounds_to_pass.max, metrics.roundsToPass.max],
    ['share_needing_5plus_rounds.count', b.share_needing_5plus_rounds.count, metrics.shareNeeding5PlusRounds.count],
    ['share_needing_5plus_rounds.share', b.share_needing_5plus_rounds.share, metrics.shareNeeding5PlusRounds.share],
    ['reverts.revert_prs_in_cohort', b.reverts.revert_prs_in_cohort, metrics.reverts.revertPrsInCohort],
  ];

  const mismatches = checks
    .filter(([, expected, actual]) => !sameNumber(expected, actual))
    .map(([field, expected, actual]) => ({ field, baseline: expected, computed: actual }));

  const truncated = Array.isArray(b.rounds_to_pass.prs_commit_data_truncated) ? b.rounds_to_pass.prs_commit_data_truncated : [];
  const computedTruncated = metrics.roundsToPass.prsCommitDataTruncated;
  if (truncated.slice().sort().join(',') !== computedTruncated.slice().sort().join(',')) {
    mismatches.push({ field: 'rounds_to_pass.prs_commit_data_truncated', baseline: truncated, computed: computedTruncated });
  }

  return { ok: true, reproduces: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// TRD-042 -- cohort comparison and the revert/incident guardrail (AC-019-3,
// AC-019-4).
// ---------------------------------------------------------------------------

/**
 * The targets REQ-019 states, each relative to the baseline. `requiredReduction`
 * is the share of the baseline value that must be removed; `null` means the
 * target only asks for a lower number, with no size attached.
 */
const TARGETS = Object.freeze([
  { id: 'rounds-to-pass', metric: 'roundsToPass.median', requiredReduction: 0.3 },
  { id: 'prs-needing-5-plus-rounds', metric: 'shareNeeding5PlusRounds.share', requiredReduction: 0.5 },
  { id: 'noise-rate', metric: 'noiseRate.value', requiredReduction: 0.3 },
  { id: 'human-approvals-median', metric: 'humanApprovalsPerPr.median', requiredReduction: null },
  { id: 'wait-on-human-p95', metric: 'waitOnHumanHours.p95', requiredReduction: null },
]);

/** The counts the guardrail watches. An increase in any of them fails the cohort (AC-019-4). */
const GUARDRAIL_METRICS = Object.freeze([
  { metric: 'revertPrsInCohort', path: 'reverts.revertPrsInCohort' },
  { metric: 'revertCommitsOnDefaultBranch', path: 'reverts.revertCommitsOnDefaultBranch' },
  { metric: 'incidents', path: 'incidents.value' },
]);

function comparisonFailure(reason) {
  return {
    ok: false,
    reason,
    cohortOk: false,
    insufficient: [],
    targets: [],
    targetsMet: false,
    guardrail: 'unknown',
    guardrailBreaches: [],
    guardrailUnknown: [],
    byTier: { baseline: [], current: [] },
    met: false,
  };
}

/** Reads `a.b.c` off a metrics object; anything that is not a finite number reads as null. */
function numberAt(metrics, dotted) {
  let value = metrics;
  for (const key of dotted.split('.')) {
    if (!isObject(value)) return null;
    value = value[key];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The snake_case metric names a committed baseline file uses -> the camelCase ones this module computes. */
function fromBaselineFile(file) {
  const b = file.metrics;
  const cohortBlock = file.cohort;
  const pick = (block, key) => (isObject(block) && typeof block[key] === 'number' ? block[key] : null);
  return {
    cohort: {
      prCount: pick(cohortBlock, 'pr_count'),
      spanDays: pick(cohortBlock, 'span_days'),
      earliestCreatedAt: isText(cohortBlock.earliest_created_at) ? cohortBlock.earliest_created_at : null,
      latestCreatedAt: isText(cohortBlock.latest_created_at) ? cohortBlock.latest_created_at : null,
    },
    metrics: {
      humanApprovalsPerPr: { median: pick(b.human_approvals_per_pr, 'median'), p95: pick(b.human_approvals_per_pr, 'p95') },
      waitOnHumanHours: { median: pick(b.wait_on_human_hours, 'median'), p95: pick(b.wait_on_human_hours, 'p95') },
      roundsToPass: { median: pick(b.rounds_to_pass, 'median'), p95: pick(b.rounds_to_pass, 'p95') },
      shareNeeding5PlusRounds: { count: pick(b.share_needing_5plus_rounds, 'count'), share: pick(b.share_needing_5plus_rounds, 'share') },
      noiseRate: { value: isObject(b.noise_rate) && typeof b.noise_rate.value === 'number' ? b.noise_rate.value : null },
      reverts: {
        revertPrsInCohort: pick(b.reverts, 'revert_prs_in_cohort'),
        revertCommitsOnDefaultBranch: pick(b.reverts, 'revert_commits_on_default_branch'),
      },
      incidents: { value: isObject(b.incidents) ? (Number.isInteger(b.incidents.value) ? b.incidents.value : null) : null },
      byTier: Array.isArray(b.by_tier) ? b.by_tier : [],
    },
  };
}

/**
 * One side of the comparison, whatever shape it arrived in: a raw cohort
 * input (`{ prs }`, computed here), a `computeMetrics` result, or a parsed
 * committed baseline file (snake_case). A side this function cannot read is
 * refused by name -- it is never treated as a cohort of zeros.
 */
function sideOf(value, name) {
  if (!isObject(value)) return { ok: false, reason: `${name} must be a cohort input, a metrics result or a baseline file` };

  if (Array.isArray(value.prs)) {
    const computed = computeMetrics(value);
    if (!computed.ok) return { ok: false, reason: `${name}: ${computed.reason}` };
    return { ok: true, cohort: computed.cohort, metrics: computed.metrics };
  }

  if (isObject(value.metrics) && isObject(value.cohort)) {
    if (isObject(value.metrics.humanApprovalsPerPr)) return { ok: true, cohort: value.cohort, metrics: value.metrics };
    if (isObject(value.metrics.human_approvals_per_pr)) return { ok: true, ...fromBaselineFile(value) };
    return { ok: false, reason: `${name}: metrics carries neither the computed nor the baseline-file field names` };
  }

  return { ok: false, reason: `${name} must be a cohort input, a metrics result or a baseline file` };
}

/** Why a cohort is too thin to compare, or null when it is big enough and long enough. */
function insufficiencyOf(cohort) {
  const prCount = Number.isInteger(cohort.prCount) ? cohort.prCount : null;
  const spanDays = Number.isInteger(cohort.spanDays) ? cohort.spanDays : null;
  if (prCount === null || spanDays === null) return { reason: 'cohort size or span was not recorded', prCount, spanDays };
  if (prCount < COHORT_MINIMUMS.prs) return { reason: `fewer-than-${COHORT_MINIMUMS.prs}-prs`, prCount, spanDays };
  if (spanDays < COHORT_MINIMUMS.days) return { reason: `shorter-than-${COHORT_MINIMUMS.days}-days`, prCount, spanDays };
  return null;
}

/**
 * Grades one target against the baseline. Every unmeasurable case is NOT MET
 * with the reason attached: a target nobody can evaluate is never evidence
 * that the change worked.
 */
function gradeTarget(target, baselineMetrics, currentMetrics) {
  const baselineValue = numberAt(baselineMetrics, target.metric);
  const currentValue = numberAt(currentMetrics, target.metric);
  const entry = {
    id: target.id,
    metric: target.metric,
    requiredReduction: target.requiredReduction,
    baseline: baselineValue,
    current: currentValue,
    achievedReduction: null,
    met: false,
  };

  if (baselineValue === null) return { ...entry, reason: 'baseline-value-unavailable' };
  if (currentValue === null) return { ...entry, reason: 'current-value-unavailable' };

  if (baselineValue === 0) {
    // Nothing can be reduced by a share of zero. Holding at zero is the only
    // outcome that is not worse than the baseline.
    return currentValue === 0
      ? { ...entry, met: true, reason: 'baseline-is-zero-held-at-zero' }
      : { ...entry, met: false, reason: 'baseline-is-zero-current-is-higher' };
  }

  const achievedReduction = (baselineValue - currentValue) / baselineValue;
  const met = target.requiredReduction === null ? currentValue < baselineValue : achievedReduction >= target.requiredReduction;
  return { ...entry, achievedReduction, met };
}

/**
 * Compares a post-change cohort with the baseline (AC-019-3, AC-019-4).
 *
 * @param {Object} input
 * @param {Object} input.baseline  A cohort input, a `computeMetrics` result or
 *   a parsed `docs/guides/review-baseline-<date>.json`.
 * @param {Object} input.current   The post-change cohort, in any of the same shapes.
 * @returns {{ok:boolean, reason?:string, cohortOk:boolean,
 *   insufficient:Array<{side:string, reason:string, prCount:?number, spanDays:?number}>,
 *   targets:Array<{id:string, metric:string, requiredReduction:?number, baseline:?number,
 *     current:?number, achievedReduction:?number, met:boolean, reason?:string}>,
 *   targetsMet:boolean, guardrail:'passed'|'failed'|'unknown',
 *   guardrailBreaches:Array<{metric:string, baseline:number, current:number}>,
 *   guardrailUnknown:Array<{metric:string, baseline:?number, current:?number}>,
 *   byTier:{baseline:Object[], current:Object[]}, met:boolean}}
 *   `met` is true only when the cohorts are big enough, every target is met
 *   AND the guardrail passed.
 */
function compareCohorts(input) {
  if (!isObject(input)) return comparisonFailure('invalid-input');

  const baseline = sideOf(input.baseline, 'baseline');
  if (!baseline.ok) return comparisonFailure(baseline.reason);
  const current = sideOf(input.current, 'current');
  if (!current.ok) return comparisonFailure(current.reason);

  const insufficient = [];
  for (const [side, value] of [['baseline', baseline], ['current', current]]) {
    const problem = insufficiencyOf(value.cohort);
    if (problem !== null) insufficient.push({ side, ...problem });
  }
  const cohortOk = insufficient.length === 0;

  // The guardrail is a matter of fact (a revert happened or it did not), so it
  // is evaluated even for a cohort too thin to certify a target.
  const guardrailBreaches = [];
  const guardrailUnknown = [];
  for (const { metric, path: dotted } of GUARDRAIL_METRICS) {
    const baselineValue = numberAt(baseline.metrics, dotted);
    const currentValue = numberAt(current.metrics, dotted);
    if (baselineValue === null || currentValue === null) {
      guardrailUnknown.push({ metric, baseline: baselineValue, current: currentValue });
    } else if (currentValue > baselineValue) {
      guardrailBreaches.push({ metric, baseline: baselineValue, current: currentValue });
    }
  }
  const guardrail = guardrailBreaches.length > 0 ? 'failed' : guardrailUnknown.length > 0 ? 'unknown' : 'passed';

  const targets = cohortOk ? TARGETS.map((target) => gradeTarget(target, baseline.metrics, current.metrics)) : [];
  const targetsMet = cohortOk && targets.every((target) => target.met);

  return {
    ok: true,
    cohortOk,
    insufficient,
    targets,
    targetsMet,
    guardrail,
    guardrailBreaches,
    guardrailUnknown,
    byTier: {
      baseline: Array.isArray(baseline.metrics.byTier) ? baseline.metrics.byTier : [],
      current: Array.isArray(current.metrics.byTier) ? current.metrics.byTier : [],
    },
    met: cohortOk && targetsMet && guardrail === 'passed',
  };
}

module.exports = {
  computeMetrics,
  checkAgainstBaseline,
  compareCohorts,
  median,
  percentile,
  DEFAULT_BOTS,
  NOISE_CLASSES,
  RESPONSE_CLASSES,
  COHORT_MINIMUMS,
  TARGETS,
  GUARDRAIL_METRICS,
};
