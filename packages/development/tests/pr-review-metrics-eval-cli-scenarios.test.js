'use strict';

/**
 * TRD-032-TEST: Metrics and eval CLI end to end (PRD scenarios).
 *
 * Verifies TRD-032 (the `metrics`, `metrics-compare`, `eval-score`,
 * `eval-compare` and `eval-stale` subcommands of `lib/pr-review-cli.js`).
 * Validates PRD ACs: AC-019-3, AC-019-4 (REQ-019), AC-020-2 (REQ-020).
 *
 * The delegation, registration and hostile-payload ACs of TRD-032 are covered
 * by pr-review-metrics-eval-cli.test.js, and the module-level scenarios by
 * pr-review-cohort-compare-scenarios.test.js and pr-review-eval-scenarios.js;
 * neither is re-stated here.
 *
 * What this file adds is the END-TO-END path a maintainer actually walks:
 * cohort data in a file -> `node lib/pr-review-cli.js <subcommand>` as a REAL
 * child process with JSON on stdin -> the reported verdict read back out of
 * stdout. Nothing is required() into this process for the verdict, so a
 * scenario cannot pass against a module the CLI would never reach: the
 * subcommand, the argument parsing, the stdin read, the module call and the
 * JSON printing are all exercised.
 *
 * Every scenario carries the case that must be REFUSED next to the case that
 * passes, so no verdict here is proven only in the direction that says yes.
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-032-test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-02-01T00:00:00Z');

/** Run the real CLI as a child process, with the payload on stdin. */
function run(subcommand, payload) {
  const result = spawnSync('node', [CLI, subcommand], { input: JSON.stringify(payload), encoding: 'utf8' });
  let out;
  try {
    out = JSON.parse(result.stdout);
  } catch {
    out = undefined;
  }
  return { status: result.status, stderr: result.stderr, out };
}

/** The same run, but the payload is read from a file the way a maintainer pipes it in. */
function runFromFile(subcommand, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-metrics-cli-'));
  try {
    const file = path.join(dir, 'payload.json');
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    const result = spawnSync('node', [CLI, subcommand], { input: fs.readFileSync(file, 'utf8'), encoding: 'utf8' });
    return { status: result.status, out: JSON.parse(result.stdout) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `count` merged PRs spread evenly over `spanDays`, each with `rounds`
 * CHANGES_REQUESTED reviews answered by a commit, `approvals` human
 * approvals and `waitHours` before the first human responds.
 */
function prs({ count, spanDays, rounds, approvals, waitHours, titlePrefix = 'feat' }) {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const opened = T0 + ((index * spanDays) / (count - 1)) * DAY;
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

/** `total` finding responses of which `noise` were wrong. */
function findingResponses(total, noise) {
  const responses = [];
  for (let index = 0; index < total; index += 1) {
    responses.push({ findingId: `f-${index}`, response: index < noise ? 'wrong' : 'fixed' });
  }
  return responses;
}

/** The captured baseline cohort: 24 PRs over 60 days, slow and noisy. */
const BASELINE = Object.freeze({
  prs: prs({ count: 24, spanDays: 60, rounds: 6, approvals: 2, waitHours: 20 }),
  findingResponses: findingResponses(100, 40),
  revertCommitsOnDefaultBranch: 3,
  incidents: 2,
});

/** The post-change cohort: same size and span, every measure improved past its target. */
const IMPROVED = Object.freeze({
  prs: prs({ count: 24, spanDays: 60, rounds: 2, approvals: 1, waitHours: 4 }),
  findingResponses: findingResponses(100, 10),
  revertCommitsOnDefaultBranch: 1,
  incidents: 0,
});

const targetById = (result, id) => result.targets.find((target) => target.id === id);

describe('Scenario AC-019-3: the maintainer compares the post-change cohort with the baseline through the CLI', () => {
  test('`pr-review-cli.js metrics-compare` reports every target relative to baseline and the cohort is met', () => {
    const { status, out } = runFromFile('metrics-compare', { baseline: BASELINE, current: IMPROVED });

    expect(status).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.cohortOk).toBe(true);
    expect(out.insufficient).toEqual([]);

    expect(targetById(out, 'human-approvals-median').current).toBeLessThan(targetById(out, 'human-approvals-median').baseline);
    expect(targetById(out, 'wait-on-human-p95').current).toBeLessThan(targetById(out, 'wait-on-human-p95').baseline);
    expect(targetById(out, 'rounds-to-pass').achievedReduction).toBeGreaterThanOrEqual(0.3);
    expect(targetById(out, 'prs-needing-5-plus-rounds').achievedReduction).toBeGreaterThanOrEqual(0.5);
    expect(targetById(out, 'noise-rate').achievedReduction).toBeGreaterThanOrEqual(0.3);

    expect(out.targets.map((target) => target.met)).toEqual([true, true, true, true, true]);
    expect(out.targetsMet).toBe(true);
    expect(out.met).toBe(true);
  });

  test('the per-cohort `metrics` run the comparison is built from is reachable through the CLI too', () => {
    const { status, out } = run('metrics', IMPROVED);

    expect(status).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.cohort.prCount).toBe(24);
    expect(out.cohort.meetsMinPrs).toBe(true);
    expect(out.cohort.meetsMinSpanDays).toBe(true);
    expect(out.metrics.roundsToPass.median).toBeGreaterThan(0);
  });

  test('the case that must be refused: a cohort that improved by less than the stated reductions is not met', () => {
    const tooLittle = {
      prs: prs({ count: 24, spanDays: 60, rounds: 5, approvals: 1, waitHours: 4 }),
      findingResponses: findingResponses(100, 35),
      revertCommitsOnDefaultBranch: 1,
      incidents: 0,
    };

    const { status, out } = runFromFile('metrics-compare', { baseline: BASELINE, current: tooLittle });

    expect(status).toBe(0);
    expect(out.cohortOk).toBe(true);
    expect(targetById(out, 'rounds-to-pass').met).toBe(false);
    expect(targetById(out, 'noise-rate').met).toBe(false);
    expect(out.met).toBe(false);
  });

  test('the second case that must be refused: a cohort thinner than 20 PRs and 30 days is rejected before any target is graded', () => {
    const thin = {
      prs: prs({ count: 12, spanDays: 14, rounds: 1, approvals: 0, waitHours: 1 }),
      findingResponses: findingResponses(100, 0),
      revertCommitsOnDefaultBranch: 0,
      incidents: 0,
    };

    const { status, out } = runFromFile('metrics-compare', { baseline: BASELINE, current: thin });

    expect(status).toBe(0);
    expect(out.cohortOk).toBe(false);
    expect(out.insufficient.map((entry) => entry.side)).toEqual(['current']);
    expect(out.targets).toEqual([]);
    expect(out.met).toBe(false);
  });
});

describe('Scenario AC-019-4: the guardrail fails the cohort through the CLI whatever else it achieved', () => {
  test('more revert commits than baseline: the same otherwise-met cohort is reported as failing the guardrail', () => {
    const regressed = { ...IMPROVED, revertCommitsOnDefaultBranch: BASELINE.revertCommitsOnDefaultBranch + 2 };

    const { status, out } = runFromFile('metrics-compare', { baseline: BASELINE, current: regressed });

    expect(status).toBe(0);
    expect(out.targetsMet).toBe(true);
    expect(out.guardrail).toBe('failed');
    expect(out.met).toBe(false);
  });

  test('more incidents than baseline: same verdict, so the guardrail is not a property of reverts alone', () => {
    const regressed = { ...IMPROVED, incidents: BASELINE.incidents + 1 };

    const { out } = runFromFile('metrics-compare', { baseline: BASELINE, current: regressed });

    expect(out.targetsMet).toBe(true);
    expect(out.guardrail).toBe('failed');
    expect(out.met).toBe(false);
  });

  test('the case that must be refused: a guardrail nobody supplied the counts for is reported unknown, never as a pass', () => {
    const noCounts = { prs: IMPROVED.prs, findingResponses: IMPROVED.findingResponses };
    const baselineNoCounts = { prs: BASELINE.prs, findingResponses: BASELINE.findingResponses };

    const { out } = runFromFile('metrics-compare', { baseline: baselineNoCounts, current: noCounts });

    expect(out.guardrail).not.toBe('passed');
    expect(out.met).toBe(false);
  });

  test('the negative control: the unregressed cohort passes the guardrail, so "failed" is not the only answer', () => {
    const { out } = runFromFile('metrics-compare', { baseline: BASELINE, current: IMPROVED });

    expect(out.guardrail).toBe('passed');
    expect(out.met).toBe(true);
  });
});

describe('Scenario AC-020-2: the eval set is run through the CLI and every case is scored and reported', () => {
  const evalCase = (overrides = {}) => ({
    id: 'case-clean-tree-gate',
    change: 'https://github.com/Sunstone-Partners/ensemble/commit/9456221',
    bug: 'the clean-tree gate was decided before resume detection',
    location: { path: 'packages/development/lib/pr-review-state.js', startLine: 90, endLine: 120 },
    confirmedBy: '@ldangelo',
    rulesFile: 'REVIEW.md',
    rulesHash: 'hash-1',
    ...overrides,
  });

  const finding = (line, severity = 'important') => ({
    id: `F-${line}`,
    source: 'reviewer-a',
    locationOrLink: `packages/development/lib/pr-review-state.js:${line}`,
    severity,
    failureMode: 'clean-tree gate decided before resume detection',
    disposition: 'fix',
    evidence: 'the gate runs before the resume branch',
    originalTextOrLink: 'https://example.invalid/pr/1#r1',
  });

  const second = evalCase({
    id: 'case-vote-threshold',
    location: { path: 'packages/development/lib/pr-review-votes.js', startLine: 1, endLine: 50 },
  });

  test('a reviewer run that found one bug and missed the other is scored per case and the share is reported', () => {
    const { status, out } = runFromFile('eval-score', {
      cases: [evalCase(), second],
      findingsByCase: {
        'case-clean-tree-gate': [finding(95)],
        'case-vote-threshold': [finding(400)],
      },
    });

    expect(status).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.cases.map((entry) => [entry.id, entry.found])).toEqual([
      ['case-clean-tree-gate', true],
      ['case-vote-threshold', false],
    ]);
    expect(out.total).toEqual({ cases: 2, found: 1, score: 0.5 });
  });

  test('the case that must be refused: a Nit at the right place is not a found bug, and a case with no recorded findings is never a pass', () => {
    const { out } = runFromFile('eval-score', {
      cases: [evalCase(), second],
      findingsByCase: { 'case-clean-tree-gate': [finding(95, 'nit')] },
    });

    expect(out.cases.map((entry) => entry.found)).toEqual([false, false]);
    expect(out.total).toEqual({ cases: 2, found: 0, score: 0 });
    expect(out.cases[1].reason).toBe('no-findings-recorded');
  });

  test('the prompts or model changed: `eval-compare` reports the drop as a regression and names the case that flipped', () => {
    const { status, out } = runFromFile('eval-compare', {
      previous: { cases: [{ id: 'case-clean-tree-gate', found: true }, { id: 'case-vote-threshold', found: true }] },
      current: { cases: [{ id: 'case-clean-tree-gate', found: true }, { id: 'case-vote-threshold', found: false }] },
    });

    expect(status).toBe(0);
    expect(out.regression).toBe(true);
    expect(JSON.stringify(out.flipped)).toContain('case-vote-threshold');
  });

  test('the negative control: an unchanged run is no regression, so the comparison is not "always regression"', () => {
    const same = { cases: [{ id: 'case-clean-tree-gate', found: true }, { id: 'case-vote-threshold', found: false }] };

    const { out } = runFromFile('eval-compare', { previous: same, current: same });

    expect(out.regression).toBe(false);
  });

  test("the rules changed under a case: `eval-stale` names it, so a score is never reported against rules it was not written for", () => {
    const { status, out } = runFromFile('eval-stale', {
      cases: [evalCase(), second],
      rulesHashes: { 'REVIEW.md': 'hash-2' },
    });

    expect(status).toBe(0);
    expect(out.stale).toContain('case-clean-tree-gate');
  });

  test('the negative control: with the recorded hash still current, no case is stale', () => {
    const { out } = runFromFile('eval-stale', {
      cases: [evalCase(), second],
      rulesHashes: { 'REVIEW.md': 'hash-1' },
    });

    expect(out.stale).toEqual([]);
  });
});
