# Local CI Gate — Baseline Note (REQ-013)

Capture date: 2026-10-21 (baseline measured; see Results)
Status: **target unproven until measured**
Gate enablement record: none — the gate is not enabled. The baseline below was
recorded before any enablement.

The numeric target and the minimum post-change cohort size/duration are
DECIDED FROM this baseline after it is measured. They are not set here, and no
figure below may be filled in from memory or estimation. Once decided, record
them in the PRD changelog (`docs/PRD/PRD-2026-4dec59b8-local-ci-pr-approval.md`).

## Capture procedure

Choose a cohort window (for example the last 30 merged PRs, or a fixed date
range) and record it below. Run from the repository root:

```sh
# 1. Merged PRs in the window: open and merge times
gh pr list --state merged --limit 30 \
  --json number,createdAt,mergedAt,headRefOid

# 2. Hosted CI wait per PR: check runs on the head commit
gh api repos/{owner}/{repo}/commits/<headRefOid>/check-runs \
  --jq '.check_runs[] | {name, started_at, completed_at, conclusion}'
#   ciWaitMs = latest completed_at - earliest started_at of the hosted CI runs

# 3. Bot-review wait per PR: reviews by the bot (e.g. coderabbitai[bot])
gh pr view <number> --json reviews \
  --jq '.reviews[] | {author: .author.login, state, submittedAt}'
#   botReviewWaitMs = first bot review submittedAt - PR createdAt
#   (or head-push time, if the bot reviewed the final head)
```

Feed `{ number, openedAt: createdAt, mergedAt, ciWaitMs, botReviewWaitMs }`
per PR to `summarizeCohort` in `packages/development/lib/local-ci-baseline.js`.
Percentiles are linear-interpolation (median = p50, p75 = p75). CI wait and
bot-review wait are reported separately and are never summed or conflated.

## Results (measured 2026-10-21)

Cohort window: 2026-10-12 to 2026-10-21 (last 30 PRs merged to `dev`)
Cohort size: 30 (rejected: 0)
Raw rows: `baseline-cohort.json` (PR number, timestamps, durations only); the
figures below are recomputed from it by `summarizeCohort`.

| Metric                       | Median | p75    | PRs with data |
| ---------------------------- | ------ | ------ | ------------- |
| Open-to-merge time           | 105.9 min | 683.5 min | 30 |
| Hosted CI wait               | 2.6 min | 2.8 min | 30 |
| Bot-review (CodeRabbit) wait | n/a | n/a | 0 |

What this says, and does not say:

- Hosted CI is about 2.5% of the median open-to-merge time on this repository. Removing it cannot
  move that median much.
- CodeRabbit left no review on any of the 30 PRs, so there is no bot-review wait to remove here.
  On this repository there is therefore nothing measurable for the bot-review half of the
  feature to remove. Whether another repository (the maintainer reports Foreman) has a
  bot-review wait is NOT measured here; run the capture procedure there.
- The p75 is inflated by PRs left open overnight and is reported as measured, not trimmed.
- This is one repository over nine days. It is a baseline, not a prediction for other
  repositories, and no post-change cohort exists.

## Decisions (made only after measurement)

- Numeric target (reduction in median and p75 open-to-merge): _undecided_
- Minimum post-change cohort size: _undecided_
- Minimum post-change duration: _undecided_

Until these are decided and a post-change cohort of at least the minimum size
exists, status is reported as `unproven`, never `met`.
