'use strict';

/**
 * TRD-011-TEST: Delta versus full re-review (PRD scenarios).
 *
 * Validates PRD ACs: AC-010-1, AC-010-3 (REQ-010).
 *
 * The Implementation AC tests for `chooseReviewRange` live in
 * pr-review-delta-range.test.js and call the library in process. These are
 * the PRD-LEVEL scenarios, run the way the pr-review-cycle skill actually
 * reaches this decision: a FRESH `node pr-review-cli.js review-range`
 * process (TRD-013), so no in-memory state can carry an answer between
 * rounds.
 *
 * Scenarios:
 *   - AC-010-1: a round after the first examines only the changes since the
 *     previously reviewed commit.
 *   - AC-010-3: a push the system cannot vouch for (an unrecorded commit, a
 *     merge commit, history that does not reach the reviewed head) falls
 *     back to a full-diff review rather than trusting the prior one.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/development/lib/pr-review-cli.js');

const BASE = '8b87a6d71146cd2e36e09c4fc265b6bb336f8798';
const REVIEWED = '914369d8ebedb871a1f1f619f3ad410f48350642';
const FIX = '2aa6fdf7dda287fe5b6212acb2e01a1c7ec4def7';

function runCli(subcommand, payload) {
  const out = execFileSync('node', [CLI, subcommand], { input: JSON.stringify(payload), encoding: 'utf8' });
  return JSON.parse(out);
}

describe('Scenario AC-010-1: a round after the first examines only the changes since the previously reviewed commit', () => {
  test('a fresh review-range process, given a vouched-for remediation commit, answers with the delta only', () => {
    const result = runCli('review-range', {
      baseSha: BASE,
      headSha: FIX,
      lastReviewedSha: REVIEWED,
      commits: [{ sha: FIX, parents: [REVIEWED] }],
      remediationShas: [FIX],
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('delta');
    expect(result.range).toBe(`${REVIEWED}..${FIX}`);
    expect(result.fullRange).toBe(`${BASE}..${FIX}`);
  });

  test('the first round, with no previously reviewed head, examines the full base-correct range', () => {
    const result = runCli('review-range', { baseSha: BASE, headSha: FIX });
    expect(result.mode).toBe('full');
    expect(result.reason).toBe('first-round');
    expect(result.range).toBe(`${BASE}..${FIX}`);
  });
});

describe('Scenario AC-010-3: a push the system cannot vouch for forces a full re-review', () => {
  test('a commit not recorded as a remediation (an agent push outside the loop) is unvouched: full range, named', () => {
    const result = runCli('review-range', {
      baseSha: BASE,
      headSha: FIX,
      lastReviewedSha: REVIEWED,
      commits: [{ sha: FIX, parents: [REVIEWED] }],
      remediationShas: [], // FIX was never recorded as a remediation commit.
    });

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('unvouched-history');
    expect(result.range).toBe(`${BASE}..${FIX}`);
    expect(result.unvouched).toEqual([{ sha: FIX, reason: 'not-a-recorded-remediation-commit' }]);
  });

  test('a merge commit in the range is unvouched: full range, named, never trusted as a clean remediation', () => {
    const otherParent = 'a'.repeat(40);
    const result = runCli('review-range', {
      baseSha: BASE,
      headSha: FIX,
      lastReviewedSha: REVIEWED,
      commits: [{ sha: FIX, parents: [REVIEWED, otherParent] }],
      remediationShas: [FIX],
    });

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('unvouched-history');
    expect(result.unvouched).toEqual([{ sha: FIX, reason: 'merge-commit' }]);
  });

  test('history that does not reach the reviewed head (a rebase or a reset) is unvouched: full range', () => {
    const unrelated = 'b'.repeat(40);
    const result = runCli('review-range', {
      baseSha: BASE,
      headSha: FIX,
      lastReviewedSha: REVIEWED,
      commits: [{ sha: FIX, parents: [unrelated] }],
      remediationShas: [FIX],
    });

    expect(result.mode).toBe('full');
    expect(result.reason).toBe('unvouched-history');
  });
});
