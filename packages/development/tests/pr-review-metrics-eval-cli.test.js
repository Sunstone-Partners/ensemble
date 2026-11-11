'use strict';

/**
 * TRD-032: the metrics and eval subcommands of `pr-review-cli.js`
 * (`metrics`, `metrics-compare`, `eval-score`, `eval-compare`, `eval-stale`)
 * and the metrics guide `docs/guides/pr-review-metrics.md`.
 *
 * Implementation AC (REQ-019, REQ-020):
 *   1. given JSON on stdin, each subcommand delegates to its module and
 *      prints that module's answer verbatim, is registered in HANDLERS and
 *      appears in BOTH usage strings, and a hostile payload never produces a
 *      clean pass;
 *   2. the guide lists the `gh` queries that produce the module inputs
 *      (reviews with commit ids, review requests, threads, revert and
 *      incident lists), the baseline-capture procedure and the cohort rule
 *      (at least 20 PRs AND at least 30 days), extending the existing pilot
 *      guide rather than duplicating it.
 *
 * Parity is checked by running the real CLI as a child process and comparing
 * its stdout with a direct `require()` call on the same input: the dispatcher
 * is only trustworthy if it can never answer something the library would not.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');
const SOURCE = fs.readFileSync(CLI, 'utf8');
const { HANDLERS } = require('../lib/pr-review-cli');
const { computeMetrics, compareCohorts } = require('../lib/pr-review-metrics');
const { scoreEval, compareEval, staleCases } = require('../lib/pr-review-eval');

const GUIDE = path.join(__dirname, '..', '..', '..', 'docs', 'guides', 'pr-review-metrics.md');

const SUBCOMMANDS = ['metrics', 'metrics-compare', 'eval-score', 'eval-compare', 'eval-stale'];

const run = (subcommand, payload) => {
  const result = spawnSync('node', [CLI, subcommand], { input: JSON.stringify(payload), encoding: 'utf8' });
  let out;
  try {
    out = JSON.parse(result.stdout);
  } catch {
    out = undefined;
  }
  return { status: result.status, out };
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-03-01T00:00:00Z');

function cohort({ count = 22, spanDays = 45, rounds = 3 } = {}) {
  const prs = [];
  for (let index = 0; index < count; index += 1) {
    const opened = T0 + ((index * spanDays) / (count - 1)) * DAY;
    const reviews = [];
    const commits = [{ committedDate: new Date(opened + HOUR / 2).toISOString() }];
    for (let round = 0; round < rounds; round += 1) {
      reviews.push({ author: { login: 'a-human' }, state: 'CHANGES_REQUESTED', submittedAt: new Date(opened + (round + 1) * HOUR).toISOString(), body: 'please change' });
      commits.push({ committedDate: new Date(opened + (round + 1) * HOUR + HOUR / 2).toISOString() });
    }
    reviews.push({ author: { login: 'approver' }, state: 'APPROVED', submittedAt: new Date(opened + (rounds + 2) * HOUR).toISOString(), body: 'lgtm' });
    prs.push({
      number: index + 1,
      title: `feat: change ${index + 1}`,
      author: { login: 'author-one' },
      createdAt: new Date(opened).toISOString(),
      mergedAt: new Date(opened + 50 * HOUR).toISOString(),
      reviews,
      comments: [],
      commits,
    });
  }
  return prs;
}

const evalCase = (overrides = {}) => ({
  id: 'case-1',
  change: { repo: 'org/repo', pr: 12, commit: 'a'.repeat(40) },
  bug: 'off-by-one in the round counter',
  location: { path: 'packages/development/lib/pr-review-status.js', startLine: 10, endLine: 12 },
  confirmedBy: 'owner-a',
  rulesFile: 'REVIEW.md',
  rulesFileHash: 'hash-1',
  ...overrides,
});

describe('TRD-032 AC: the five subcommands are registered and documented', () => {
  test('each is in HANDLERS and is a function', () => {
    for (const name of SUBCOMMANDS) {
      expect(typeof HANDLERS[name]).toBe('function');
    }
  });

  test('both usage strings -- the header comment and the unknown-subcommand error -- list each one', () => {
    const usageLines = SOURCE.split('\n').filter((line) => line.includes('Usage:'));
    expect(usageLines).toHaveLength(2);
    for (const line of usageLines) {
      for (const name of SUBCOMMANDS) {
        expect([line.slice(0, 20), name, line.includes(name)]).toEqual([line.slice(0, 20), name, true]);
      }
    }
  });

  test('the header documents the payload each one takes', () => {
    for (const name of SUBCOMMANDS) {
      expect(SOURCE).toMatch(new RegExp(`\\*\\s+${name}\\s`));
    }
  });
});

describe('TRD-032 AC: each subcommand delegates to its module and prints its answer verbatim', () => {
  test('metrics is computeMetrics', () => {
    const payload = { prs: cohort(), findingResponses: [{ findingId: 'f1', response: 'fixed' }], incidents: 1, revertCommitsOnDefaultBranch: 2 };
    const { status, out } = run('metrics', payload);
    expect(status).toBe(0);
    expect(out).toEqual(JSON.parse(JSON.stringify(computeMetrics(payload))));
    expect(out.metrics.roundsToPass.median).toBeGreaterThan(0);
  });

  test('metrics-compare is compareCohorts', () => {
    const payload = {
      baseline: { prs: cohort({ rounds: 6 }), findingResponses: [{ response: 'wrong' }, { response: 'fixed' }], incidents: 2, revertCommitsOnDefaultBranch: 2 },
      current: { prs: cohort({ rounds: 2 }), findingResponses: [{ response: 'fixed' }, { response: 'fixed' }], incidents: 0, revertCommitsOnDefaultBranch: 0 },
    };
    const { status, out } = run('metrics-compare', payload);
    expect(status).toBe(0);
    expect(out).toEqual(JSON.parse(JSON.stringify(compareCohorts(payload))));
    expect(out.cohortOk).toBe(true);
    expect(out.guardrail).toBe('passed');
  });

  test('eval-score is scoreEval', () => {
    const payload = {
      cases: [evalCase()],
      findingsByCase: {
        'case-1': [{ id: 'f1', severity: 'Important', location: 'packages/development/lib/pr-review-status.js:11' }],
      },
    };
    const { status, out } = run('eval-score', payload);
    expect(status).toBe(0);
    expect(out).toEqual(JSON.parse(JSON.stringify(scoreEval(payload))));
  });

  test('eval-compare is compareEval', () => {
    const payload = {
      previous: { cases: [{ id: 'case-1', found: true }, { id: 'case-2', found: true }] },
      current: { cases: [{ id: 'case-1', found: true }, { id: 'case-2', found: false }] },
    };
    const { status, out } = run('eval-compare', payload);
    expect(status).toBe(0);
    expect(out).toEqual(JSON.parse(JSON.stringify(compareEval(payload))));
    expect(out.regression).toBe(true);
    expect(out.flipped.map((entry) => entry.id || entry)).toContain('case-2');
  });

  test('eval-stale is staleCases', () => {
    const payload = { cases: [evalCase()], rulesHashes: { 'REVIEW.md': 'hash-2' } };
    const { status, out } = run('eval-stale', payload);
    expect(status).toBe(0);
    expect(out).toEqual(JSON.parse(JSON.stringify(staleCases(payload))));
    expect(out.stale).toContain('case-1');
  });
});

describe('TRD-032 AC: a hostile payload never produces a clean pass', () => {
  const hostile = [
    ['metrics', { prs: 'all of them' }],
    ['metrics', { prs: [{ number: 1 }], metrics: { roundsToPass: { median: 0 } } }],
    ['metrics-compare', { baseline: { ok: true, met: true }, current: { ok: true, met: true } }],
    ['metrics-compare', { baseline: { prs: cohort({ count: 4, spanDays: 3 }) }, current: { prs: cohort({ count: 4, spanDays: 3 }) } }],
    ['eval-score', { cases: 'none', findingsByCase: {} }],
    ['eval-score', { cases: [evalCase()], findingsByCase: { 'case-1': [{ id: 'f1', severity: 'Nit', location: 'packages/development/lib/pr-review-status.js:11' }] } }],
    ['eval-compare', { previous: 'better', current: 'worse' }],
    ['eval-stale', { cases: [evalCase()], rulesHashes: 'all current' }],
  ];

  test.each(hostile)('%s refuses a payload that claims its own verdict', (subcommand, payload) => {
    const { status, out } = run(subcommand, payload);
    expect(status).toBe(0);
    expect(out).toBeDefined();
    // Whatever the payload asserted about itself, the answer is the module's
    // own: never an `ok` pass, a met comparison or a found case it did not
    // compute.
    const passed = out.ok === true && (out.met === true || out.found === true || (out.total && out.total.found > 0) || out.regression === false);
    expect(passed).toBe(false);
  });

  test('malformed JSON on stdin is a CLI error for every one of them, never a default result', () => {
    for (const name of SUBCOMMANDS) {
      const result = spawnSync('node', [CLI, name], { input: '{not json', encoding: 'utf8' });
      expect([name, result.status]).toEqual([name, 1]);
      expect(JSON.parse(result.stdout).error).toMatch(/invalid JSON/);
    }
  });
});

describe('TRD-032 AC: docs/guides/pr-review-metrics.md', () => {
  const guide = () => fs.readFileSync(GUIDE, 'utf8');

  test('the guide exists and names each subcommand a maintainer runs', () => {
    expect(fs.existsSync(GUIDE)).toBe(true);
    for (const name of SUBCOMMANDS) {
      expect(guide()).toContain(`pr-review-cli.js ${name}`);
    }
  });

  test('it lists the gh queries that produce the module inputs', () => {
    const text = guide();
    expect(text).toMatch(/gh (pr|api|search)/);
    for (const input of ['commit', 'review request', 'thread', 'revert', 'incident']) {
      expect([input, text.toLowerCase().includes(input)]).toEqual([input, true]);
    }
  });

  test('it states the cohort rule as an AND: at least 20 PRs and at least 30 days', () => {
    const text = guide();
    expect(text).toMatch(/at least 20 PRs/i);
    expect(text).toMatch(/at least 30 days/i);
    expect(text).toMatch(/\bAND\b|both/);
  });

  test('it carries the baseline-capture procedure and points at the committed baseline', () => {
    const text = guide();
    expect(text).toMatch(/baseline/i);
    expect(text).toContain('docs/guides/review-baseline-');
  });

  test('it extends the pilot guide rather than duplicating it', () => {
    const text = guide();
    expect(text).toContain('pr-review-cycle-time-pilot.md');
    // The five cycle-time metric definitions stay in the pilot guide.
    expect(text).not.toMatch(/### 3\.1 Median open-to-merge time/);
  });
});
