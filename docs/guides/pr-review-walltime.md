# PR Review Wall Time: the Baseline and the Before/After Compare

How to compare the wall time of a PR review with what it was before the speedup of
[`docs/plans/pr-review-speedup-plan.md`](../plans/pr-review-speedup-plan.md), with the
`pr-review-cli.js walltime` subcommand (kata `vrda`, epic `ptqb`; plan section 5, second bullet:
"compare median and p75 wall time by tier, and the number of gate runs and review chains per PR,
before and after"). Nothing here runs by itself: a maintainer feeds it cohort files and reads the
verdict.

This is the sibling of [`pr-review-metrics.md`](pr-review-metrics.md). `metrics` and
`metrics-compare` compare a cohort of merged PRs by **count** (approvals, rounds, waits) against
`review-baseline-<date>.json`; `walltime` compares review **wall time** against
`review-walltime-baseline-<date>.json`. The two files have different schemas and are not
interchangeable.

## 1. What is measured

| Term | Meaning |
|---|---|
| **run** | One review orchestrator task, from its first work to its verdict, on one PR. One row of a cohort. |
| **tier** | `low`, `medium` or `high`: the effective tier `pr-review-cli tier` computed for the PR in that review (the `effectiveTier` of the state report's `tier` record). Never a guess from the size of the diff. |
| **round** | `first` (the first review of the PR) or `re-review` (a review after a push). |
| **stratum** | A (tier, round) pair, written `high/re-review`. The three rows of the plan's section 2 table are the **required strata**: `medium/first`, `high/first`, `high/re-review`. |
| **wall_min** | The run's wall time in minutes: the plan's section 1 figure for a baseline row, `timing.wall` (the orchestrator window) for a row built from a trace. `null` with a reason when the run never reached a verdict or the figure was not recorded. |
| **chains** | Review chains the run covers. A head change restarts the whole reviewer, verifier and verdict chain, so a run that went through two heads is two chains. |
| **gate_runs** | Local-CI gate runs the run needed (a flake re-run counts). `null` with a reason when it was not recorded, never zero. |
| **origin** | `real` (a real review of a real PR), `stand-in` (scripted agents) or `fixture`. Only `real` rows count. |

A PR's gate runs and review chains are the sums over its rows. A median is taken over runs; the
minimum below is counted over distinct PRs.

## 2. The rule for `met`, `not-met` and `unknown`

For each stratum, `walltime compare` answers one of three things:

- **`unknown`**: either side has fewer than **three distinct PRs with a wall time** in the stratum
  (`MINIMUMS.prsPerStratum` in `lib/pr-review-walltime.js`). Three is the least for which a median
  and a 75th percentile mean anything (the nearest-rank p75 of three runs is the slowest one); it is
  a floor, not a significance test. There is no payload key to lower it: lowering it is a change to
  that file. A thin stratum is never `met` and never `not-met`, because a verdict needs data.
- **`met`**: the current median is at most **a fifth** of the baseline median **and** the current p75
  is at most a fifth of the baseline p75 (5x, the plan's "20% of today's wall time"; the tail must not
  hide behind the median).
- **`not-met`**: both sides have the data and at least one of the two is above a fifth.

Where the plan's own figure is ambiguous the baseline takes the **smaller** (harder) reading, and the
current side is the whole orchestrator window (the larger reading), so the comparison cannot flatter
the new pipeline.

### The 5x claim (`fiveX`)

`fiveX.claim` is `met` only when **every required stratum is `met` and the current cohort holds a real
re-review in which verdicts were carried across heads** (a row with `origin: "real"`,
`round: "re-review"`, a wall time and `carry.carried` of at least 1). That is the plan's section 5 rule:
"Do not claim the 5x target met until PR 4 has run on a real re-review" (PR 4 is the `carry` child,
`qw98`). Otherwise:

- any required stratum `not-met` is `not-met`;
- anything else (a required stratum `unknown`, or no carried re-review) is `unknown`, and
  `fiveX.reasons` names each missing piece.

A stratum that is not required (a `low` tier, a `medium/re-review`) is graded and reported, and a miss
is a warning, but the claim does not depend on it.

## 3. The committed baseline

[`review-walltime-baseline-2026-11-07.json`](review-walltime-baseline-2026-11-07.json) is the BEFORE
side: the runs of the plan's section 1, six runs on four PRs, all measured under the pre-speedup
process (an LLM orchestrator dispatching every agent by hand).

| Run | PR | Tier | Round | Wall (min) | Chains | Gate runs |
|---|---|---|---|---|---|---|
| `pr225-first` | #225 | medium | first | 66 | 1 | 3 |
| `pr228-first` | #228 | high | first | 39 | 1 | 1 |
| `pr229-first` | #229 | high | first | 55 | 1 | 2 |
| `pr233-first` | #233 | high | first | 82 | 2 | 2 |
| `pr233-rereview-1` | #233 | high | re-review | 70 | 1 | 1 |
| `pr233-rereview-2` | #233 | high | re-review | none (aborted, no verdict) | 1 | 1 |

What it supports, and what it does not:

- **Only `high/first` has the minimum** of three PRs (#228, #229, #233: median 55 min, p75 82 min).
  `medium/first` has one PR (#225) and `high/re-review` has one (#233), so a compare against either is
  `unknown` until pre-speedup runs are added or the minimum is changed in code. This is the honest size
  of the data the plan measured, not a defect of the schema.
- **The tiers are the CLI's, not the plan table's.** The plan's section 2 gives Medium as 40 to 65 min,
  which matches the span of #225, #228 and #229 (39 to 66 min). By `pr-review-cli tier` only #225 was
  medium; #228 and #229 were high (#229 raised from medium by the second assessment). The measured high
  first reviews are 39, 55 and 82 min, and 20% of their median is 11 min, below the plan's 16 to 24 min
  target that came from an estimated 80 to 120 min.
- **#233 is four chains, one of them with no wall time.** Round 1 spans two heads (the PR's head moved
  mid-run), the re-review is the third chain, and the fourth (`Merge233R4`) was aborted before any
  verdict, so it counts as a chain and a gate run but has no wall time.
- **The re-review figure leaves out time.** The plan's 70 min runs from the first agent start to the
  last verifier's last message. It excludes the orchestrator's 8.4 min before its first dispatch and
  the 28.1 min re-run of a verifier killed by a 429, so the baseline is smaller than the whole chain.
  That makes a 5x claim harder, not easier.
- What was considered and left out (fix rounds, the gate's own duration, per-agent figures, #202, and
  the #234 and #235 prototype runs) is in the file's `excluded` list, each with its reason; strata with
  no run are in `unmeasured`.

### Where the figures come from

`provenance` in the file names the sources, and `packages/development/tests/pr-review-walltime-baseline.test.js`
checks them:

- **The plan.** Each wall figure and the gate runs of #225 and #229 are quoted from the table in
  section 1; the test finds each cell in the plan and fails if it moves. The #233 rows are the plan's
  restatement from each agent's last `message` event (correction C01), not from `session_exit`.
- **The omp session files.** The plan's numbers were measured from the omp session of the interactive
  agent that dispatched the orchestrators. Those files are on a maintainer's machine, not in the
  repository, so CI cannot read them; `provenance.sessions.checks` records what they gave when they
  were re-read on 2026-11-07 (orchestrator window first record to last `message`: 66.6, 39.3, 55.4 and
  82.3 min; 70.4 min for the #233 re-review, or 77.4 min measured to `session_exit`; tier and gate runs
  per PR). The test checks that those agree with the rows: the plan's whole minutes are the sessions'
  task durations cut to the minute.

To re-run one of those checks, point this at a session file (the interval is the first record to the
last record of type `message`, never `session_exit`, which is a 7:00 idle linger after the final
yield):

```bash
SESSIONS=~/.omp/agent/sessions/-Development-Sunstone-ensemble.local-ci/2026-10-24T23-07-57-756Z_01a1702b-bfbc-73ff-9648-26dd9df425c6
node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const time = (row) => Date.parse(row.timestamp);
const first = Math.min(...rows.map(time).filter(Number.isFinite));
const last = Math.max(...rows.filter((row) => row.type === "message").map(time).filter(Number.isFinite));
console.log(((last - first) / 60000).toFixed(1), "min");
' "$SESSIONS/Merge225.jsonl"
```

Never edit this baseline in place: a baseline that moves proves nothing. To add pre-speedup runs,
write a new dated file (the same rows plus yours, each with its `source`), and say in it which
process they were measured under.

## 4. Running it

Every action is JSON in, JSON out, and exits 0 even when it refuses: read `ok`, `status` and
`fiveX.claim`, never the exit code alone. A payload key it does not know, or a request it cannot
read, is an error (exit 1).

```bash
CLI=packages/development/lib/pr-review-cli.js
BASELINE=docs/guides/review-walltime-baseline-2026-11-07.json

# 4.1 The statistics of one cohort file (per stratum: runs, PRs, median and p75; per tier: gate runs
#     and review chains per PR). Run on the baseline it reproduces its stored `metrics`.
jq -n --slurpfile cohort "$BASELINE" '{action: "summarize", cohort: $cohort[0]}' | node "$CLI" walltime

# 4.2 One row from a recorded review, read from its trace exactly as `timing` reads it
#     (<cwd>/.ensemble/state/toolchain/trace-<runId>.jsonl).
jq -n '{action: "row", runId: "RUN-ID", pr: 271, tier: "high", round: "first", origin: "real"}' \
  | node "$CLI" walltime

# 4.3 The comparison. `current` is a cohort file of rows from 4.2: {"schema": "review-walltime-cohort/1", "runs": [...]}
jq -n --slurpfile baseline "$BASELINE" --slurpfile current CURRENT.json \
  '{action: "compare", baseline: $baseline[0], current: $current[0]}' | node "$CLI" walltime
```

### Building the current cohort

Collect one `row` answer per real post-change review (`.row` of the answer) into a `runs` array.
Each run needs the PR, the tier the CLI assigned, the round, and `origin: "real"` for a review of a
real PR by model agents (`stand-in` for scripted agents and `fixture` for a recorded fixture are kept
in the file and listed as excluded, never counted).

For a re-review that used carry-over, add `carry` to the `row` request:
`{"carry": {"headSha": "<the re-reviewed head>", "verdicts": <the verdicts array of the PR's state report>}}`.
The state report is `.ensemble/pr-review/pr-<N>.json`; the `carry` subcommand is the only producer of
the verdict records the evidence counts (those stamped with this head and a `carriedFrom` that is
another head; see [`pr-review-carry.md`](pr-review-carry.md)). The row then stores
`{carried, head_sha, from_heads}`.

### Reading the answer

| Field | Reading |
|---|---|
| `strata[]` | Per stratum: `baseline` and `current` (`runs`, `prs`, `runsWithoutWall`, `medianMin`, `p75Min`), the `target` (a fifth of the baseline median and p75), `status` (`met`, `not-met`, `unknown`), `medianMet` and `p75Met`, `speedup` (only when graded) and `reasons`. |
| `counts[]` | Per tier, gate runs and review chains per PR, baseline against current, with the change in the median and p75. Reported, never graded (the plan sets no target); `unknown` under the same three-PR minimum. |
| `perPr` | The per-PR delivery on each side: its runs, review chains, gate runs and total wall time (`null` with a reason when a run has none). |
| `carry` | Whether a real carried re-review is in the current cohort, and the rows that show it. |
| `fiveX` | `claim` (`met`, `not-met`, `unknown`), `met`, and `reasons`. |
| `excluded` | Rows left out of every statistic because their origin is not `real`. |
| `warnings` | A PR on both sides; a non-required stratum that was not met. |

## 5. Honest limits

- `origin` is the caller's statement. Nothing signs a row, so this code cannot tell a real review
  from a typed one. What it does: leave `stand-in` and `fixture` rows out of every statistic and out
  of the carry evidence, and require carry evidence to name a count of carried verdicts and two
  different full object ids. A state report is an untracked file, so the evidence is attested, not
  proven.
- A stratum compares run times. It does not normalise for the size of the PRs in it, and three PRs is
  a floor, not a significance test.
- Metrics describe a cohort; they do not establish cause. A faster review alongside a pipeline change
  is evidence to discuss, not proof.
- The quality guard (a faster review must not lose a real Important finding) is a separate check and
  is not part of this comparison.
