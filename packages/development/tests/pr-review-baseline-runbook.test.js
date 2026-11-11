/**
 * TRD-044-TEST: the baseline capture runbook (docs/guides/pr-review-cycle-time-pilot.md §6)
 * produces the full REQ-019 metric set (AC-019-1, AC-019-2), and the committed baseline carries it.
 * The jq program is extracted from the runbook itself and run with the real `jq` binary.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RUNBOOK = path.join(REPO_ROOT, 'docs/guides/pr-review-cycle-time-pilot.md');
const BASELINE_GLOB = /^review-baseline-\d{4}-\d{2}-\d{2}\.json$/;

const METRIC_KEYS = [
  'human_approvals_per_pr',
  'human_comments',
  'wait_on_human_hours',
  'rounds_to_pass',
  'share_needing_5plus_rounds',
  'noise_rate_by_author_response_class',
  'reverts',
  'incidents',
];

function extractProgram() {
  const text = fs.readFileSync(RUNBOOK, 'utf8');
  const section = text.slice(text.indexOf('## 6. Review-process baseline capture'));
  const match = section.match(/```jq\n([\s\S]*?)\n```/);
  if (!match) throw new Error('runbook §6 has no ```jq program');
  return match[1];
}

function runProgram(prs) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'baseline-'));
  const prog = path.join(dir, 'baseline.jq');
  const input = path.join(dir, 'prs.json');
  fs.writeFileSync(prog, extractProgram());
  fs.writeFileSync(input, JSON.stringify(prs));
  const res = spawnSync('jq', ['-f', prog, input,
    '--argjson', 'reverts_on_default', '2',
    '--arg', 'captured_on', '2026-01-01',
    '--arg', 'cohort_definition', 'fixture',
    '--arg', 'cohort_note', 'fixture note'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`jq failed: ${res.stderr || res.error}`);
  return JSON.parse(res.stdout);
}

const iso = (d) => new Date(Date.UTC(2026, 0, 1) + d * 3600 * 1000).toISOString().replace('.000Z', 'Z');

function pr(number, day, extra = {}) {
  return {
    number,
    title: `PR ${number}`,
    author: { login: 'alice' },
    createdAt: iso(day * 24),
    mergedAt: iso(day * 24 + 10),
    reviews: [],
    comments: [],
    commits: [{ committedDate: iso(day * 24 + 1) }],
    ...extra,
  };
}

describe('pr-review baseline runbook (TRD-044-TEST)', () => {
  test('AC-019-1/2: produces every metric on a fixture cohort, with correct values', () => {
    const prs = [
      pr(1, 0, {
        reviews: [
          { author: { login: 'bob' }, state: 'APPROVED', submittedAt: iso(5), body: 'lgtm' },
          { author: { login: 'github-actions' }, state: 'COMMENTED', submittedAt: iso(2), body: 'bot' },
        ],
        comments: [{ author: { login: 'bob' }, createdAt: iso(4), body: 'nit' }],
      }),
      pr(2, 31, { title: 'Revert "x"' }),
    ];
    const out = runProgram(prs);
    expect(Object.keys(out.metrics).sort()).toEqual([...METRIC_KEYS].sort());
    expect(out.cohort).toMatchObject({ pr_count: 2, span_days: 31, meets_min_prs: false, meets_min_span_days: true });
    expect(out.metrics.human_approvals_per_pr).toMatchObject({ median: 0.5, p95: 1, prs_with_any: 1 });
    // bob's approval body + bob's comment count; the bot review does not
    expect(out.metrics.human_comments.total).toBe(2);
    expect(out.metrics.wait_on_human_hours).toMatchObject({ median: 4, prs_with_human_response: 1, prs_with_no_human_response: 1 });
    expect(out.metrics.rounds_to_pass.max).toBe(0);
    expect(out.metrics.share_needing_5plus_rounds).toEqual({ count: 0, share: 0 });
    expect(out.metrics.reverts).toEqual({ revert_prs_in_cohort: 1, revert_commits_on_default_branch: 2 });
  });

  test('counts 5+ fix rounds and p95 by nearest rank', () => {
    const reviews = [];
    const commits = [{ committedDate: iso(0.5) }];
    for (let i = 1; i <= 5; i += 1) {
      reviews.push({ author: { login: 'bob' }, state: 'CHANGES_REQUESTED', submittedAt: iso(i * 2), body: '' });
      commits.push({ committedDate: iso(i * 2 + 1) });
    }
    const out = runProgram([pr(1, 0, { reviews, commits, mergedAt: iso(30) })]);
    expect(out.metrics.rounds_to_pass.max).toBe(5);
    expect(out.metrics.share_needing_5plus_rounds).toEqual({ count: 1, share: 1 });
  });

  test('p95 is nearest rank (ceil), median is the true median', () => {
    // 21 PRs; PR k has k human comments (k = 0..20) -> p95 = ceil(0.95*21)=20th value = 19, median = 10
    const prs = [];
    for (let k = 0; k <= 20; k += 1) {
      const comments = [];
      for (let c = 0; c < k; c += 1) comments.push({ author: { login: 'bob' }, createdAt: iso(2), body: 'x' });
      prs.push(pr(k + 1, k, { comments }));
    }
    const out = runProgram(prs);
    expect(out.metrics.human_comments.p95_per_pr).toBe(19);
    expect(out.metrics.human_comments.median_per_pr).toBe(10);
  });

  test('the PR author is never counted as a human reviewer', () => {
    const out = runProgram([pr(1, 0, {
      reviews: [{ author: { login: 'alice' }, state: 'APPROVED', submittedAt: iso(2), body: 'self' }],
      comments: [{ author: { login: 'alice' }, createdAt: iso(3), body: 'reply' }],
    })]);
    expect(out.metrics.human_approvals_per_pr.prs_with_any).toBe(0);
    expect(out.metrics.human_comments.total).toBe(0);
    expect(out.metrics.wait_on_human_hours.prs_with_no_human_response).toBe(1);
  });

  test('noise rate and incidents are null with a reason, never invented', () => {
    const out = runProgram([pr(1, 0)]);
    for (const key of ['noise_rate_by_author_response_class', 'incidents']) {
      expect(out.metrics[key].value).toBeNull();
      expect(out.metrics[key].reason.length).toBeGreaterThan(20);
    }
  });

  test('runbook states the cohort rule (>=20 PRs and >=30 days, an AND)', () => {
    const text = fs.readFileSync(RUNBOOK, 'utf8');
    expect(text).toMatch(/at least 20 PRs AND spans at least 30 calendar\s+days/);
    expect(text).toContain('review-baseline-<date>.json');
  });

  test('a committed baseline file carries the full metric set and cohort record', () => {
    const files = fs.readdirSync(path.join(REPO_ROOT, 'docs/guides')).filter((f) => BASELINE_GLOB.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/guides', f), 'utf8'));
      expect(Object.keys(data.metrics).sort()).toEqual([...METRIC_KEYS].sort());
      expect(data.cohort.definition).toBeTruthy();
      expect(data.cohort.note).toBeTruthy();
      expect(data.cohort.pr_count).toBeGreaterThan(0);
      expect(data.cohort.earliest_created_at).toBeTruthy();
      expect(data.cohort.latest_created_at).toBeTruthy();
    }
  });
});
