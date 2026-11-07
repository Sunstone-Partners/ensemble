# Light-mode review runner (`review-run-cli.js`)

Light mode (tier Low or Medium, as `selectMode` answers) is run through one re-entrant Node script,
`packages/development/lib/review-run-cli.js`, with two subcommands, `prepare` and `collect`. Each takes one JSON
object on stdin and prints one JSON object on stdout (exit 0 when `ok:true`, 1 when `ok:false`). Resolve it the
way `PR_REVIEW_CLI` is resolved (tool-path-resolution skill, file `lib/review-run-cli.js`); if it does not
resolve or Node.js is missing, use the narrated Steps 1-10 below instead. The runner cannot start model agents:
you do, from its manifest. Never retry a non-zero exit with guessed input.

The model composes no brief, computes no vote, sets no status and writes no ledger field. The runner does all of
that; REVIEW_COMPLETE is only ever relayed from the CLI's `deriveStatus`.

## What you do

1. `prepare` with `{ repo, pr, repoRoot }` (optional keys: `runId`, `traceRunId`, `baseSha`, `lastReviewedSha`,
   `remediationShas`, `dryRun`, `skipPrecheck`, `testFiles`, `testCommand`, `baselineTimeoutMs`, `nodeModules`,
   `stateRoot`, `agentAuthored`). Unknown keys are refused.
2. On `status: 'DISPATCH'` start exactly the agents in `agents[]`, no more and no fewer. Give each its `prompt`
   UNEDITED to a fresh-context, read-only subagent. Never run more at once than `maxConcurrentAgents`, and stop an
   agent that has not finished at its `deadlineAtIso`: the runner records deadlines but cannot stop an agent.
3. When the agents have finished (or been stopped), call `collect` with `{ repoRoot, runId }` (`runId` from the
   manifest). Only those keys, plus `adjudications` in step 5.
4. `DISPATCH` again (the next verify wave, with fresh deadlines): repeat step 2. `PENDING`: wait for
   `waitingOn` (about `retryAfterMs`), then call `collect` again; never treat a pending agent as having reviewed.
5. `ADJUDICATE` (ok:true): the result already carries the gate, computed with every listed item held open. Decide
   ONLY the items in `adjudicate[]`, each as `fix`, `deferred` or `not-applicable` with a reason, and re-enter
   `collect` with `adjudications:[{id, disposition, reason}]`. An item not listed cannot be adjudicated, and an
   Important or security finding cannot be cleared this way.
6. `DONE` (ok:true): stop. Report `gate`, `reviewStatus`, `ledger`, `votes` and `notReviewed` as given; the
   `notReviewed` list is part of the report, not noise. `collect` on a finished run returns the stored result.

## Statuses

| status | ok | You do |
|---|---|---|
| `DISPATCH` | true | start the manifest's agents, then `collect` |
| `PENDING` | true | wait, then `collect` again |
| `ADJUDICATE` | true | decide the listed items only, `collect` with `adjudications` |
| `DONE` | true | stop and report |
| `NEEDS_FULL_MODE` | false | nothing was dispatched: run the narrated Steps 1-10 (full mode) from the start |
| `RUN_INVALIDATED` | false | the head moved: the run is over and nothing it produced is usable; start a new run on the new head |
| `RUN_FAILED` | false | report the `reason`; when it is `head-unreadable` a later `collect` may be retried, anything else is `REVIEW_BLOCKED` naming the error |

`NEEDS_FULL_MODE` is the fallback, not an error to work around: tier High, a sensitive path, or a tier that
cannot be read or is contradictory selects full mode, and the narrated procedure is unchanged. Never pass a
light-mode verdict off for a full-mode one.

## Honest limits

* Deadlines and the concurrency cap are enforced by whoever dispatches (you), not by the runner.
* Delta re-review, carry-forward, sharding and verification pools are not built; `lastReviewedSha` and
  `remediationShas` are only passed through to `prepare`, and reviewers read the full range.
* `prepare` runs the precheck first: it posts one PR comment and starts the local-CI gate in the background
  unless `dryRun` or `skipPrecheck` is set. A precheck that fails is recorded and does not stop the run.
* The baseline test run executes the head's own test code in a scratch directory; it is not a sandbox
  (`docs/guides/pr-review-prepare.md`).
* The runner never edits the reviewed tree and never pushes.

Guide with a worked example: `docs/guides/pr-review-run.md`.
