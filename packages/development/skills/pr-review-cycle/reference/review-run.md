# Review runner (`review-run-cli.js`)

Both modes, light and full, are run through one re-entrant Node script,
`packages/development/lib/review-run-cli.js`, with two subcommands, `prepare` and `collect`. Each takes one JSON
object on stdin and prints one JSON object on stdout (exit 0 when `ok:true`, 1 when `ok:false`). Resolve it the
way `PR_REVIEW_CLI` is resolved (tool-path-resolution skill, file `lib/review-run-cli.js`); if it does not
resolve or Node.js is missing, use the narrated Steps 1-10 in SKILL.md instead. The runner cannot start model agents:
you do, from its manifest. Never retry a non-zero exit with guessed input.

The model composes no brief, computes no vote, sets no status and writes no ledger field. The runner does all of
that; REVIEW_COMPLETE is only ever relayed from the CLI's `deriveStatus`.

## Mode

The mode comes only from `selectMode` over the tier the CLI computes: never from the diff's size, never from an
agent's judgement, never from a payload key (a `mode` key is refused as unknown). Tier Low or Medium is `light`. An
unreadable tier, a raised tier, any ambiguity, tier High or a sensitive or High path is `full`. No path downgrades a
full run to light mid-run.

Full differs from light only in four ways: (1) Deep depth always (at least 2 reviewers per slice, 5 verifiers per
finding, whatever the tier word says); (2) the security lane always; (3) a `TRIAGE` stop between the review round and
the verify round, where you may add candidates the reviewers missed; (4) the re-review scope rule under
`reReview` below. Briefs are still generated from templates, and the gate, the approvals, the independence of
reviewers and verifiers, REVIEW_COMPLETE (the CLI only) and "a path nobody reviewed is reported as not reviewed" are
the same as in light mode.

## What you do

1. `prepare` with `{ repo, pr, repoRoot }` (optional keys: `runId`, `traceRunId`, `baseSha`, `lastReviewedSha`,
   `remediationShas`, `dryRun`, `skipPrecheck`, `testFiles`, `testCommand`, `baselineTimeoutMs`, `nodeModules`,
   `stateRoot`, `agentAuthored`). Unknown keys are refused. `baseSha` is a check, not an override: the runner takes the
   merge base itself and refuses any other value (`base-not-merge-base`). It also refuses, before anything is
   fetched, run or posted, a head on a fork or whose repository GitHub did not state, and a PR that is not OPEN.
2. On `status: 'DISPATCH'` start exactly the agents in `agents[]`, no more and no fewer. Give each its `prompt`
   UNEDITED to a fresh-context, read-only subagent. Never run more at once than `maxConcurrentAgents`, and stop an
   agent that has not finished at its `deadlineAtIso`: the runner records deadlines but cannot stop an agent.
3. When the agents have finished (or been stopped), call `collect` with `{ repoRoot, runId }` (`runId` from the
   manifest). Only those keys, plus `triage` in step 5 or `adjudications` in step 6.
4. `DISPATCH` again (the next verify wave, with fresh deadlines): repeat step 2. `PENDING`: wait for
   `waitingOn` (about `retryAfterMs`), then call `collect` again; never treat a pending agent as having reviewed.
5. `TRIAGE` (ok:true, full mode only): the review round is collected and the candidates are deduplicated, and nothing
   is dispatched. The answer lists every candidate (`id`, `locationOrLink`, `severity`, `failureMode`, `source`), the
   coverage (`unreviewedSlices`, uncovered paths), the security lane status, the `reReview` decision and the rules.
   Dispatch nothing. Read it for what the reviewers missed (for instance an interaction between slices) and call
   `collect` AGAIN with `{ repoRoot, runId, triage: { additionalCandidates: [{ locationOrLink: "path/file.js:12",
   failureMode, severity: "important" | "nit", evidence }] } }`; an empty list or `{}` means you have nothing to add.
   A `collect` without `triage` only repeats the `TRIAGE` answer: the run cannot reach verification without it. Triage
   can ONLY ADD: each added candidate gets source `orchestrator` and goes through the same 5 independent
   fresh-context verifiers as every other candidate, whose briefs carry the claim and location only, never anything
   you concluded; `pre-existing` is not an allowed severity for it. You never remove, merge away, re-grade, close or
   waive a candidate, never mark a slice reviewed, never set a verdict and never decide a gate. A refused `triage`
   (an unknown key, a bad location, more than 20 candidates, a severity other than `important` or `nit`) is
   `RUN_FAILED` with reason `triage-refused` and is not terminal: fix the payload and call `collect` again.
6. `ADJUDICATE` (ok:true): the result already carries the gate, computed with every listed item held open. Decide
   ONLY the items in `adjudicate[]`, each as `fix`, `deferred` or `not-applicable` with a reason, and re-enter
   `collect` with `adjudications:[{id, disposition, reason}]`. An item not listed cannot be adjudicated, and an
   Important or security finding cannot be cleared this way.
7. `DONE` (ok:true): stop. Report `gate`, `reviewStatus`, `ledger`, `votes`, `notReviewed`, `mode`, `reReview` and
   `triage` (`{turns, additionalCandidateIds}`) as given; the
   `notReviewed` list is part of the report, not noise. `collect` on a finished run re-reads the PR first and returns
   the stored result only while the head is still the reviewed one on an open PR: a head that moved after `DONE` is
   `RUN_INVALIDATED`, and the old answer is not repeated.

## Statuses

| status | ok | You do |
|---|---|---|
| `DISPATCH` | true | start the manifest's agents, then `collect` |
| `PENDING` | true | wait, then `collect` again |
| `TRIAGE` | true | full mode only; dispatch nothing: `collect` again with `triage` (your additional candidates, or an empty list) |
| `ADJUDICATE` | true | decide the listed items only, `collect` with `adjudications` |
| `DONE` | true | stop and report |
| `NEEDS_FULL_MODE` | false | light mode only, and only when a brief the renderer refuses (for example a path with a space) means the runner cannot review mechanically: nothing was dispatched, run the narrated Steps 1-10 from the start |
| `RUN_INVALIDATED` | false | the head moved (at any `collect`, a finished run's included): the run is over and nothing it produced is usable; start a new run on the new head |
| `RUN_FAILED` | false | report the `reason` and the error: the review did not run to a verdict, so treat it as blocked. `head-unreadable` and `pr-not-open` leave a started run retryable by a later `collect`; `triage-refused` is not terminal either (fix the `triage` payload and call again); `brief-refused` is a full-mode brief the renderer refuses; at `prepare` the refusals `cross-repository-head`, `head-repository-unknown`, `pr-not-open` and `base-not-merge-base` mean nothing was fetched, run or posted |

`NEEDS_FULL_MODE` is the light-mode fallback, not an error to work around, and never a way to full mode: full mode runs
in this runner. When a light run cannot review mechanically, nothing was dispatched and the narrated procedure is
unchanged. In full mode a refused brief is `RUN_FAILED` with reason `brief-refused`. Never pass a light-mode verdict
off for a full-mode one: the answer's `mode` says which it was.

## Re-review scope (`reReview`)

The run, the `TRIAGE` answer and the final answer record `reReview: {scope, reasons: [...]}`. `delta` only when a
previous reviewed head was supplied (`lastReviewedSha`), the prepared range is a readable delta whose plan says delta,
the CLI has seen that head (the review state recorded it) and no path in the delta is High or sensitive. `full` (a full
re-read) whenever the delta touches a High or sensitive path, the head was never seen, or anything is unreadable.
`first-review` when there is no previous head. The honest limit: the runner has no delta-only read path yet (carry-over
of verdicts is kata qw98, PR #268), so every run still has reviewers read the whole range, the superset;
`reReview.appliedRange` is always `full-range` today and records the decision for the carry-over work to consume.

## Honest limits

* Deadlines and the concurrency cap are enforced by whoever dispatches (you), not by the runner.
* Carry-over of verdicts, sharding and verification pools are not built. `remediationShas` is only passed through to
  `prepare`; `lastReviewedSha` feeds the `reReview` decision only, and reviewers read the full range.
* `prepare` runs the precheck first: it posts one PR comment and starts the local-CI gate in the background
  unless `dryRun` or `skipPrecheck` is set. A precheck that fails is recorded and does not stop the run.
* The baseline test run executes the head's own test code in a scratch directory; it is not a sandbox
  (`docs/guides/pr-review-prepare.md`).
* The runner never edits the reviewed tree and never pushes.
* A head from outside this repository is never reviewed (`cross-repository-head`, `head-repository-unknown`), whatever
  the options: `skipPrecheck` and `dryRun` do not skip the check. The baseline would run the fork's test code on this
  machine and the agents would be handed its snapshot. Read the diff
  by hand. A same-repository head's code does run (in the baseline and, unless `skipPrecheck` is set, in the precheck's
  gate): this guards against code from outside the repository, not against a hostile branch inside it. The baseline
  also runs before the tier and mode are known, so a same-repository PR that turns out to be full mode has already had
  its related tests run.
* Coverage is self-reported: a slice counts as reviewed when the agent lists its paths in `pathsReviewed`, and the
  runner cannot tell a read from a claim. Read-only access for agents is an instruction in the prompt that the runner
  cannot enforce: the dispatcher must.
* A reviewer's `pre-existing` severity is checked against the diff and the head, not taken on its word: it stands only
  when the cited `file:line` names a regular file of the head (exact spelling; a symlink is never followed), that line is
  in the file, and it is outside every hunk of the PR's diff; otherwise (a changed line, a path that names no such file,
  a line past the end of the file, an unreadable diff) the finding is graded Important and the reviewer's word is kept as
  `claimedSeverity`. That checks lines, not cause: a defect this change causes in an untouched caller is outside the diff.
* Important versus Nit is the reviewer's classification and is not verified, and a finding labelled Nit does not block the
  gate (the shared gate skips Nit findings, `pr-review-gate.js`, AC-008-4): a real defect called a Nit never makes
  `mergeable` false. The narrated flow shares the exemption; closing it changes the shared gate's contract (owner decision).
* `agentAuthored` is the caller's statement and cannot be checked (an agent PR is committed under the maintainer's own
  login, so the author cannot say): `true` lets a `Directed by:` line credit one approval, `false` waives that line,
  absent is the strictest reading. A stated value is named in the answer's `warnings`.
* Trace: spans go to `.ensemble/state/toolchain/trace-<traceRunId>.jsonl`. `traceRunId` defaults to the review's own
  `runId`, so a review has a trace file of its own; its spans join a `/ensemble-pr-merge` run's trace only when the
  caller passes that run's id as `traceRunId`. Nothing passes it for you, and `/ensemble-pr-merge` does not today.
* `metrics.orchestratorTurns.atLeast` counts the model turns the protocol itself requires (runner calls plus dispatch
  rounds): a lower bound, not a transcript count. `metrics.wallMs` and `metrics.orchestratorTurns` are recorded
  honestly and `metrics.triageCalls` counts the `triage` calls. No before/after comparison against the narrated flow has
  been run on a live PR: no speedup and no turn target is claimed, and for full mode the High-tier saving is UNMEASURED
  (the 5x target is not claimed for it).
* Triage is a model judgement, but it can only add candidates, and what it adds is verified by fresh-context verifiers
  that never see its reasoning; it never removes, grades or closes anything, and never sets a verdict.
* Call `collect` one at a time per run: the run file has no lock, and two overlapping calls can each emit the next wave.
* A finished run's stored answer is as of its finalise: a repeat `collect` re-reads only the head and the PR's open
  state, so the approvals, branch protection and `mergeable` it holds can be out of date. Start a new run for a
  current verdict.

Guide with a worked example: `docs/guides/pr-review-run.md`.
