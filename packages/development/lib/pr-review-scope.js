'use strict';

/**
 * Review scope resolver.
 *
 * Resolves the exact base..head SHA range to review. NO shell, NO git
 * calls -- the caller supplies already-resolved SHAs; this module never
 * substitutes a guessed base (e.g. a bare ref name) for a real commit, and
 * never accepts a bare ref (`main`, `HEAD`, `origin/x`, an abbreviated SHA)
 * as a SHA: a ref moves, so `main..HEAD` is not a head-bound range. Every
 * SHA input must be a full object id (40 hex, or 64 hex for SHA-256 repos).
 *
 * isObjectId is the one definition of that rule: pr-review-status.js requires
 * it rather than keeping a second copy, so `scope` and `status` can never
 * disagree about what a SHA is.
 */

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Blank values (undefined, null, empty or whitespace-only strings) count as not provided. */
function isProvided(value) {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

/** typeof guard first: RegExp#test would coerce an array or object wrapping a valid id into a match. */
function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

/**
 * @param {Object} input
 * @param {string} [input.baseRef]            Informational only -- never used to guess a base SHA.
 * @param {string} [input.baseSha]
 * @param {string} [input.headSha]
 * @param {string} [input.mergeBaseSha]        The fork point of the head and the base branch: it never moves.
 * @param {string} [input.prBaseSha]           The base branch tip the PR was opened against: it moves with every merge
 *   into the base branch, so it is the last resort.
 * @param {string} [input.parentPhaseTipSha]   Stacked-phase parent branch tip; takes priority over every other base.
 * @returns {{ok:true, baseSha:string, headSha:string, range:string} |
 *   {ok:false, status:'REVIEW_BLOCKED', missing:string[], invalid:string[]}}
 *   `missing` names required inputs that were not provided; `invalid` names provided inputs that are not full object
 *   ids. A provided-but-invalid input blocks even when another input could have served, so a malformed stacked-phase
 *   tip is never silently replaced by a trunk base.
 *
 * The base is the FIRST provided candidate of: parentPhaseTipSha, baseSha, mergeBaseSha, prBaseSha. Candidates that
 * differ are not a conflict and never block -- they differ legitimately: a stacked phase's parent tip is by design
 * neither the trunk fork point nor the trunk tip, and prBaseSha differs from mergeBaseSha for every PR whose base
 * branch has advanced since the fork. The order is what keeps the range base-correct: a range that starts at the
 * moving prBaseSha contains the REVERSE of every commit that landed on the base branch after the fork.
 */
function resolveReviewScope(input = {}) {
  const { headSha, baseSha, mergeBaseSha, prBaseSha, parentPhaseTipSha } = input || {};

  // Stacked-phase tip excludes the parent phase's own history and any later
  // phase, so it always wins over a trunk base SHA when present. Among the
  // trunk bases the fixed fork point beats the moving base branch tip.
  const baseCandidates = [
    ['parentPhaseTipSha', parentPhaseTipSha],
    ['baseSha', baseSha],
    ['mergeBaseSha', mergeBaseSha],
    ['prBaseSha', prBaseSha],
  ].filter(([, value]) => isProvided(value));

  const missing = [];
  const invalid = [];

  if (baseCandidates.length === 0) missing.push('baseSha');
  for (const [name, value] of baseCandidates) {
    if (!isObjectId(value)) invalid.push(name);
  }

  if (!isProvided(headSha)) {
    missing.push('headSha');
  } else if (!isObjectId(headSha)) {
    invalid.push('headSha');
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, status: 'REVIEW_BLOCKED', missing, invalid };
  }

  const resolvedBase = baseCandidates[0][1];
  return { ok: true, baseSha: resolvedBase, headSha, range: `${resolvedBase}..${headSha}` };
}


/** A readable commit fact: `{ sha, parents[] }`, every id a full object id. */
function isCommitFact(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && isObjectId(value.sha)
    && Array.isArray(value.parents)
    && value.parents.every((parent) => isObjectId(parent))
  );
}

/** The full-range answer, with the reason the delta was refused. */
function fullRange(scope, reason, unvouched = []) {
  return {
    ok: true,
    mode: 'full',
    range: scope.range,
    fullRange: scope.range,
    baseSha: scope.baseSha,
    headSha: scope.headSha,
    reason,
    unvouched,
  };
}

/**
 * Chooses the range a re-review examines (TRD-011, AC-010-1, AC-010-3).
 *
 * After the first round the answer is `lastReviewedSha..headSha`: only what
 * changed since the last review, so the author is not re-reviewed on code
 * nobody touched. That delta is offered ONLY when every commit in it can be
 * vouched for:
 *
 *   - no merge commit (a hand-resolved merge can carry anything);
 *   - every commit is one the review-state report recorded as a remediation
 *     commit (an agent or a person pushing outside the loop is not vouched
 *     for);
 *   - the parent chain from the head reaches the reviewed head, and nothing
 *     off that chain was handed in (a rebase, a reset or a force-push breaks
 *     this).
 *
 * Anything else -- including commit facts that are missing or unreadable, and
 * a reviewed head that is unknown or not a full object id -- falls back to
 * the full base-correct range. The module never guesses a reviewed head and
 * never reviews less than it can justify.
 *
 * @param {Object} input  Everything `resolveReviewScope` takes, plus:
 * @param {string} [input.lastReviewedSha]     The head the previous round reviewed.
 * @param {Array<{sha:string, parents:string[]}>} [input.commits]  The commits in
 *   `lastReviewedSha..headSha`, newest first or in any order.
 * @param {string[]} [input.remediationShas]   The remediation commits recorded in the review-state report.
 * @returns {{ok:true, mode:'delta'|'full', range:string, fullRange:string, baseSha:string,
 *   headSha:string, lastReviewedSha?:string, reason:string, unvouched:Array<{sha:string, reason:string}>}
 *   | {ok:false, status:'REVIEW_BLOCKED', missing:string[], invalid:string[]}}
 */
function chooseReviewRange(input) {
  const request = input === null || typeof input !== 'object' || Array.isArray(input) ? {} : input;
  const scope = resolveReviewScope(request);
  if (!scope.ok) return scope;

  const { lastReviewedSha } = request;
  if (!isProvided(lastReviewedSha)) return fullRange(scope, 'first-round');
  if (!isObjectId(lastReviewedSha)) return fullRange(scope, 'reviewed-head-unknown');

  const delta = {
    ok: true,
    mode: 'delta',
    range: `${lastReviewedSha}..${scope.headSha}`,
    fullRange: scope.range,
    baseSha: scope.baseSha,
    headSha: scope.headSha,
    lastReviewedSha,
    unvouched: [],
  };

  if (lastReviewedSha === scope.headSha) return { ...delta, reason: 'head-unchanged' };

  const { commits, remediationShas } = request;
  if (commits === undefined || commits === null) return fullRange(scope, 'commit-facts-unavailable');
  if (!Array.isArray(commits) || !Array.from(commits).every(isCommitFact)) {
    return fullRange(scope, 'commit-facts-unreadable');
  }
  if (commits.length === 0) return fullRange(scope, 'commit-facts-unavailable');

  const recorded = remediationShas === undefined || remediationShas === null ? [] : remediationShas;
  if (!Array.isArray(recorded) || !Array.from(recorded).every((sha) => isObjectId(sha))) {
    return fullRange(scope, 'remediation-record-unreadable');
  }
  const remediation = new Set(Array.from(recorded).map((sha) => sha.toLowerCase()));

  const facts = new Map(Array.from(commits).map((commit) => [commit.sha.toLowerCase(), commit]));
  const unvouched = [];
  const seen = new Set();

  // Walk the first-parent chain from the head back to the reviewed head. A
  // chain that runs out before reaching it is history this module cannot
  // vouch for -- it is not evidence that nothing else changed.
  let cursor = scope.headSha.toLowerCase();
  while (cursor !== lastReviewedSha.toLowerCase()) {
    const commit = facts.get(cursor);
    if (commit === undefined) {
      const previous = [...seen].pop();
      unvouched.push({
        sha: seen.size === 0 ? scope.headSha : facts.get(previous).sha,
        reason: seen.size === 0 ? 'head-commit-missing-from-history' : 'history-does-not-reach-reviewed-head',
      });
      break;
    }
    if (seen.has(cursor)) {
      unvouched.push({ sha: commit.sha, reason: 'history-does-not-reach-reviewed-head' });
      break;
    }
    seen.add(cursor);

    if (commit.parents.length > 1) unvouched.push({ sha: commit.sha, reason: 'merge-commit' });
    else if (!remediation.has(cursor)) unvouched.push({ sha: commit.sha, reason: 'not-a-recorded-remediation-commit' });

    if (commit.parents.length === 0) {
      unvouched.push({ sha: commit.sha, reason: 'history-does-not-reach-reviewed-head' });
      break;
    }
    cursor = commit.parents[0].toLowerCase();
  }

  // Anything handed in that is not on that chain is also unvouched for: it
  // was pushed, then moved aside, and this module will not assume it is gone.
  for (const commit of commits) {
    if (!seen.has(commit.sha.toLowerCase())) unvouched.push({ sha: commit.sha, reason: 'not-on-the-reviewed-chain' });
  }

  if (unvouched.length > 0) return fullRange(scope, 'unvouched-history', unvouched);
  return { ...delta, reason: 'delta-since-last-review' };
}

module.exports = { resolveReviewScope, chooseReviewRange, isObjectId };
