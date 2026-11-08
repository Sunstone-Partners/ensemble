# PR review: the review runner (light and full mode)

The review is driven by a Node script instead of a model narrating each step:
`packages/development/lib/review-run-cli.js`. It does everything that needs no model (read the PR, precheck, prepare
the head, plan depth and slices, render briefs, collect agent results, deduplicate, tally votes, evaluate the gate) and
hands the model one job: start the agents it names. In full mode the model has one more: the `TRIAGE` stop (below).
The skill (`packages/development/skills/pr-review-cycle/SKILL.md`, `reference/review-run.md`) tells the model
how; this guide is the contract.

## Mode

There is one runner. The mode comes only from `selectMode` over the tier the CLI computes: never from the diff's size,
never from an agent's judgement and never from a payload key (a payload `mode` key is refused as an unknown key). Tier
Low or Medium is `light`. An unreadable tier, a raised tier, any ambiguity, tier High or a sensitive or High path is
`full`. No path downgrades a full run to light mid-run: every `collect` first checks the stored run. Its mode label must
be what `selectMode` says for the tier the run itself stores, and a full run must still be Deep, with five verifiers and
the lane; a label rewritten to light, removed or unknown is `RUN_FAILED` with reason `mode-invariant`, in every stored
phase. `run.json` is local state nobody authenticates, so this catches an edit of one of those fields, not a record whose
tier, label, depth and lane were all rewritten together.

Full mode differs from light in four ways, and the fourth is only a record: (1) Deep depth always (at least 2 reviewers
per slice and 5 verifiers per finding, whatever the tier word says); (2) the security lane always; (3) a
model-orchestrator `TRIAGE` stop between the review round and the verify round; (4) the re-review scope rule
(`reReview`, below), which is recorded and changes nothing a reviewer reads: reviewers read the whole range in both modes
today. Briefs are still generated from templates, and the gate, the approvals, the independence of reviewers and
verifiers, REVIEW_COMPLETE (relayed from the CLI only) and "a path nobody reviewed is reported as not reviewed" are
identical to light mode.

The runner cannot start model agents, cannot stop one, and never edits the reviewed tree or pushes. It makes no
speed claim: how much time it saves is measured separately (kata `q3a9`), and for full mode the High-tier saving is
UNMEASURED.

```bash
node packages/development/lib/review-run-cli.js prepare < payload.json
node packages/development/lib/review-run-cli.js collect < payload.json
```

One JSON object on stdout. Exit 0 when `ok:true`, 1 when `ok:false`. Invalid JSON, an unknown subcommand and an
unknown payload key are `{ok:false, error}`.

## Protocol

1. `prepare` reads the PR, runs the precheck, prepares the head (`docs/guides/pr-review-prepare.md`), computes the
   tier from the changed paths, picks the mode, plans depth and slices and renders the briefs. It answers
   `DISPATCH` with a manifest, or (light mode, a brief the renderer refuses) `NEEDS_FULL_MODE`, or (full mode, a brief
   the renderer refuses) `RUN_FAILED` with reason `brief-refused` and its stated decision (see Statuses).
2. The dispatcher starts the manifest's agents (fresh context, read-only), each with its `prompt` unedited, at
   most `maxConcurrentAgents` at once, each stopped at its `deadlineAtIso`.
3. `collect` re-reads the head, collects what has arrived and answers one of the statuses below. Verifier agents
   beyond the concurrency cap come in later waves, each with fresh deadlines, so a queued agent never spends its
   deadline waiting.
4. Repeat 2-3 on `DISPATCH` and `PENDING` until `DONE` or `ADJUDICATE`. In full mode, after the last review wave is
   collected, `collect` answers `TRIAGE` instead of dispatching verifiers; see Triage.

## Payloads

`prepare`: `{ repo: "owner/name", pr, repoRoot, runId?, traceRunId?, baseSha?, lastReviewedSha?,
remediationShas?, dryRun?, skipPrecheck?, testFiles?, testCommand?, baselineTimeoutMs?, nodeModules?,
stateRoot?, agentAuthored? }`. `runId` defaults to `pr<N>-<head12>-<epoch seconds>` and must be file-name safe.
`traceRunId` names the trace file (see Trace). `baseSha` is a check, not an override: the runner computes the merge base
of the fetched base branch and the head itself and refuses any other value, because a base inside the PR would
review only its suffix and leave the earlier commits unreported. `agentAuthored` (boolean) is the caller's statement of
who wrote the PR, which the runner cannot verify: `true` lets a `Directed by:` line credit the person it names as one
approval, `false` waives that line, and absent is the strictest reading (the line is required and nobody is credited).
A stated value is named in the answer's `warnings`. `dryRun` goes to the precheck; `skipPrecheck: true` skips it and
records that. A precheck that fails is recorded, not fatal.

`prepare` refuses, as `RUN_FAILED` with a named `reason`, before anything is fetched, prepared, run or posted: a head on a
fork (`cross-repository-head`), a head whose repository GitHub did not state (`head-repository-unknown`) and a PR that is
not OPEN (`pr-not-open`). A `baseSha` that is not the merge base (`base-not-merge-base`) is refused before prepare.

`collect`: `{ repoRoot, runId, now?, adjudications?, triage? }` and nothing else; everything else is read from the run
directory. `adjudications` is `[{ id, disposition: "fix" | "deferred" | "not-applicable", reason }]`. `triage` is
`{ additionalCandidates: [{ locationOrLink: "path/file.js:12", failureMode, severity: "important" | "nit", evidence }] }`
and is only for the `TRIAGE` status.

## Statuses

| status | ok | meaning |
|---|---|---|
| `DISPATCH` | true | manifest: `runId`, `round` (`review` or `verify`), `wave`, `headSha`, `mode`, `tier`, `depth`, `maxConcurrentAgents`, `agents[]` (`name`, `role`, `briefPath`, `outPath`, `prompt`, `dispatchedAt`, `deadlineAt`, `deadlineAtIso`, and `sliceId`, `paths`, `candidateIds` where they apply), `next`, `rules` |
| `PENDING` | true | agents still outstanding: `waitingOn`, `retryAfterMs`, `earliestDeadlineAt`; call `collect` again |
| `TRIAGE` | true | full mode only. After the last review wave is collected the runner has deduplicated the candidates and planned verification, and dispatched nothing. The answer carries the candidate list (`id`, `locationOrLink`, `severity`, `failureMode`, `source`), the coverage (`unreviewedSlices`, uncovered paths), the security lane status, the `reReview` decision and the rules. Call `collect` again with `triage` |
| `DONE` | true | `gate`, `reviewStatus`, `ledger`, `votes`, `notReviewed`, `precheck`, `statePath`, `metrics`, `mode`, `reReview`, `triage` (`{turns, additionalCandidateIds}`) |
| `ADJUDICATE` | true | as `DONE`, plus `adjudicate: [{ id, why }]`; the gate already treats those items as open |
| `RUN_INVALIDATED` | false | the head moved, at any `collect` including one on a finished run (`reason: head-moved`); the run's answer is never repeated for the new head, and a started run that was invalidated before it finished stays so |
| `NEEDS_FULL_MODE` | false | light mode only, a brief the renderer refuses (for example a path with a space): nothing was dispatched and the runner cannot review mechanically; the narrated Steps 1-10 in the skill remain the manual procedure |
| `RUN_FAILED` | false | a stage failed or a refusal: `head-unreadable` and `pr-not-open` leave a started run retryable; `triage-refused` is not terminal (fix the `triage` payload and call again); `brief-refused` is a full-mode brief the renderer refuses, and its answer carries `decision` and `fallback` (below); `mode-invariant` is a stored run whose mode label, depth, verifier count or lane no longer says what it was prepared as; `cross-repository-head`, `head-repository-unknown`, `pr-not-open` and `base-not-merge-base` at `prepare` mean nothing was run |

An agent that never arrives is reported, never read as having reviewed: its slice is in `notReviewed` and a
verifier that did not arrive leaves its finding unverified. `REVIEW_COMPLETE` is only ever relayed from the
review status function. Adjudication applies only to items that were listed, records `adjudicatedBy:
"orchestrator"`, and cannot clear an Important or security finding. `NEEDS_FULL_MODE` (light mode only) means nothing
was dispatched and the narrated Steps 1-10 in the skill remain the manual procedure; it is never the way into full mode.
In full mode a refused brief (for example a changed path with a space in it) is `RUN_FAILED` with reason
`brief-refused`, and that is a decision, not a gap: the run fails closed, is never lowered to light mode and is never run
without the brief, so the runner gives no review and no verdict for that PR. The answer states this (`decision`) and the
two ways forward (`fallback`): change what the renderer refused (rename the path) and start a new run, or review the PR
by hand with the narrated Steps 1-10, from the start. The choice is the operator's; the runner never makes it.

## Triage (full mode)

At `TRIAGE` the model dispatches nothing. It reads the candidates for what the reviewers missed (for instance an
interaction between slices) and calls `collect` AGAIN with a `triage` payload; an empty list or `{}` means it has
nothing to add. A `collect` without `triage` while in triage only repeats the `TRIAGE` answer: the run cannot reach
verification without it. Triage can ONLY ADD candidates. Each added candidate gets source `orchestrator` and goes
through the same 5 independent fresh-context verifiers as every other candidate; their briefs carry the claim and
location only, never anything the orchestrator concluded, and `pre-existing` is not an allowed severity for it. Triage
can never remove, merge away, re-grade, close or waive a candidate, never mark a slice reviewed and never set a verdict.
A refused `triage` payload (an unknown key, a location that is not a line of a regular file of the head snapshot named by a
repository-relative path, more than the cap of 20 candidates, a severity other than `important` or `nit`, or an entry the
verifier brief refuses, for example a claim that reads as a vote, a verdict, the orchestrator or a conclusion, or a path
with whitespace) is `RUN_FAILED` with reason `triage-refused`; it is not terminal: fix the payload and call again. For the
verifier brief the answer names the entry (`additionalCandidates[n]`) and the renderer's own reason (the check is the
renderer's, not a copy of its rules), and one refused entry refuses the whole payload: nothing of it is kept. Without that
check such an entry would be kept unverified and block the gate. An entry that matches a candidate the reviewers already
raised is dropped: that candidate stays exactly as it was.

## Re-review scope (`reReview`)

The run, the `TRIAGE` answer and the final answer record `reReview: {scope: 'first-review' | 'delta' | 'full',
reasons: [...]}`. `delta` only when a previous reviewed head was supplied (`lastReviewedSha`), the prepared range is a
readable delta whose plan says delta, the CLI has seen that head (the review state recorded it) and no path in the delta
is High or sensitive. `full` (a full re-read) whenever the delta touches a High or sensitive path, the head was never
seen, or anything is unreadable. `first-review` when there is no previous head. The honest limit: the runner has no
delta-only read path yet (carry-over of verdicts is kata qw98, PR #268), so every run still has reviewers read the whole
range, the superset. `reReview.appliedRange` is always `full-range` today; the field records the decision for the
carry-over work to consume.

## Run directory

`<repoRoot>/.ensemble/pr-review/run/<runId>/`: `run.json` (state; phase `review-dispatched`, `verify-dispatched`,
`done`, or `needs-full-mode`, `invalidated`, `failed`), `briefs/`, `results/<round>/` (agents write
`out-<name>.json` there, atomically: temp file, then rename) and `final.json`. Files are written atomically with
mode 0600 (directories 0700). `collect` on a finished run re-reads the PR first and returns the stored result only while
the head is still the reviewed one on an open PR. A head that moved after `DONE` is `RUN_INVALIDATED` and the stored
answer is not returned; nothing is recorded, so it is that commit's answer again only if the head returns to it.

## Honest limits

- Deadlines and the concurrency cap are the dispatcher's to enforce; the runner only computes and records them.
- Carry-over of verdicts, sharding and verification pools are later work. `remediationShas` is only passed through to
  `prepare`; `lastReviewedSha` feeds the `reReview` decision only, and reviewers read the full range.
- `prepare` runs the precheck: it posts one PR comment and starts the local-CI gate in the background unless
  `dryRun` or `skipPrecheck` is set.
- The baseline test run executes the head's own test code in a scratch directory. It is not a sandbox; see
  `docs/guides/pr-review-prepare.md`. It runs the relevant test files only. When it produced no usable result (no
  relevant test files, a timeout) the status fact is `tests skipped`, never a pass and never a failure it did not
  have.
- The runner never calls a classifier or second-assessor agent. The tier comes from the changed paths alone: prose
  files (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`) are cited as `docs`, every other path as `product`.
  That can raise a tier, never lower it, and the Low waiver is never applied. A path the repository declares
  sensitive or high (in this repository `packages/development/lib/**` is a high path) selects full mode, which runs
  in this same runner with the `TRIAGE` stop. A tier record that carries a raise (`raised` is not empty; `selectMode`
  selects full for one) cannot be produced through the runner: `prepareRun` passes `assignTier` no second assessment and
  no proposed tier, so that case is exercised only with an injected tier record.
- Finding ids in the ledger are opaque (`f1`, `s1`); the id an agent wrote is kept as `reportedId`. In light mode a
  reviewer or security-lane brief the renderer refuses (for example a path with a space in it) answers
  `NEEDS_FULL_MODE` (nothing dispatched; the narrated Steps 1-10 are the manual procedure); in full mode it is
  `RUN_FAILED` with reason `brief-refused` and a stated decision (never lowered to light, no verdict, the operator's two
  ways forward: see Statuses). A refused verifier brief keeps its candidate, unverified, and lists it under
  `notReviewed.unbriefable`; for an entry the orchestrator adds at triage the refusal comes first, as `triage-refused`.
- The final answer and `run.json` carry `mode` (the real mode), `triage` (`{turns, additionalCandidateIds}`) and
  `reReview`.
- A head from outside this repository is never reviewed (`cross-repository-head`, `head-repository-unknown`), whatever
  the options: `skipPrecheck` and `dryRun` do not skip the check. The baseline would run the fork's test code on this
  machine and the agents would be handed its snapshot. Read the diff by
  hand. A same-repository head's code does run (in the baseline and, unless `skipPrecheck` is set, in the precheck's
  gate), so this guards against code from outside the repository, not against a hostile branch inside it. The baseline
  also still runs before the tier and mode are known, so a same-repository PR that turns out to be full mode has already
  had its related tests run.
- Coverage is self-reported: a slice counts as reviewed when the agent lists its paths in `pathsReviewed`, and the
  runner cannot tell a read from a claim. Read-only access for agents is an instruction in the prompt that the runner
  cannot enforce.
- A reviewer's `pre-existing` severity is checked against the diff and the head, not taken on its word. It stands only
  when the cited `file:line` names a regular file of the head, spelled exactly, with that line in it, and lies outside
  every hunk of the PR's diff (hunks include their context lines), or names such a file the PR does not touch. The lookup
  gives the same answer on every host: each segment of the path must match a directory entry as the head's tree spells
  it (a mis-cased name names no file, on a case-insensitive volume too), nothing is followed (a symlink, a directory, a
  FIFO and a device are not files of the head, and a link a PR adds cannot make the runner read outside the snapshot or
  wait on a FIFO), and only a regular file is opened. A claim on a changed line, a location that is not a plain
  `file:line` (`file:12:5`, `file#L12`, no line), a path that names no such file (truncated, mis-spelled, mis-cased,
  carrying a git `a/` or `b/` prefix or a relative snapshot path, invented, or a link), a line past the end of the file,
  a changed file with no hunk to place it against, and an unreadable diff are graded Important: the agent's word is kept
  as `claimedSeverity`, `severity` is named in `strippedFields`, and the reduced-review notice lists them. That checks
  lines, not cause: a defect this change causes in an untouched caller is outside the diff. Security-lane findings block
  whatever their label.
- Important versus Nit is the reviewer's classification and nothing verifies it, and a finding labelled Nit does not
  block the gate: the shared gate skips Nit findings (`pr-review-gate.js`, AC-008-4), so a real defect a reviewer calls a
  Nit stays in the ledger but never makes `mergeable` false. That is the effect `pre-existing` had before it was checked.
  The narrated flow shares the exemption. Closing it (a verifier vote on Nits, a severity floor, or no exemption in light
  mode) changes the shared gate's contract, so it is an owner decision and is not made here.
- `collect` takes no lock: call it one at a time per run. Two overlapping calls can each emit the next wave.
- A finished run's stored answer is as of its finalise: replaying it re-reads only the head and the PR's open state, so
  the approvals, branch protection and `mergeable` it holds can be out of date. Start a new run for a current verdict.

## Metrics

`DONE` and `ADJUDICATE` carry `metrics` (also in `final.json` and `run.json`): `wallMs`, `runnerCalls`, `runnerMs`,
`dispatchRounds`, `agentsDispatched`, `agentsByRole` (reviewer, security, verifier), `adjudicationCalls`, `triageCalls`,
`agentActiveMs`, `orchestratorOnlyMs` and `orchestratorTurns`. `orchestratorTurns.atLeast` is the number of model turns
the protocol itself requires: one per runner call plus one per dispatch round. It is a lower bound, not a transcript
count: the runner cannot see how many turns the dispatching model really took, so turns spent outside the protocol
(reading the skill, retries, the report) and re-reads of a finished run are not counted. `agentsByRole`,
`adjudicationCalls` and `triageCalls` show where model turns went beyond the orchestrator's own. `wallMs` and
`orchestratorTurns` are recorded honestly for full mode too; the High-tier saving is UNMEASURED and no speedup (the 5x
target included) is claimed for it. Measuring it is kata `q3a9`'s job, not this runner's.

## Trace

Stage spans (precheck, prepare-head, one per agent, the gate) go to
`<repoRoot>/.ensemble/state/toolchain/trace-<traceRunId>.jsonl`. `traceRunId` defaults to the review's own `runId`, so a
review writes a trace file of its own. Its spans land in the same file as a `/ensemble-pr-merge` run's trace only when the
caller passes that run's id as `traceRunId`. Nothing passes it automatically and the `/ensemble-pr-merge` prose does not
today, so a merge's trace and its review's trace are separate files unless the caller joins them. Tracing never fails a run.
The span names are the runner's own, and `pr-review-timing.js` reads other ones (see Left open).

## Left open

What kata znd1 asked for and this runner does not do (none is claimed):

- The comparison against the narrated flow (AC5: same blockers and same Important findings on real PRs, with wall time and
  orchestrator turns before and after) has not been run, and no result is claimed, for light or full mode. The runner
  now refuses merged PRs, so the comparison needs an open PR reviewed through both flows.
- `/ensemble-pr-merge` is not rewired to the runner: the skill points `MODE=local` and `MODE=gate` at it and the command
  prose still reaches the gate through the skill only.
- `reviewDecision` is not consumed: approvals come from the PR's reviews with the existing withdrawal rule.
- Deadlines and the concurrency cap are the dispatcher's to enforce. Tier kinds come from paths, not from a classifier agent.
  Carry-over of verdicts, delta-only reading and sharding are not built.

Known defects the one real full-mode run found. None is fixed in this change; each is tracked on its own:

- The default 15-minute deadline for a reviewer or the security lane is too short for a large whole-PR slice. A Deep
  run's security lane can arrive late, be recorded `expired` and leave the gate on `security-review-missing` (kata `sfpb`).
  In the real run the lane needed 17m45s and the gate named `security-review-missing`.
- The verifier brief refuses a claim that names the orchestrator or a verdict, and a path with whitespace (kata `0g9n`). A
  reviewer-raised candidate like that stays `unverified`, listed under `notReviewed.unbriefable`, and blocks the gate. An
  entry the orchestrator adds is refused at triage instead, so it can be reworded in the same run.
- `review-run-cli.js` `peekRun` reads `run.json` at a `runId` it has not validated yet, before `collect` rejects a bad
  one (kata `yz76`). Only `repo` and `pr` are taken from it.
- Agent spans are named `agent:<name>` and the security lane's role is `security`, while `pr-review-timing.js` reads
  `review.reviewer`, `review.verifier` and `review.security-lane` (and `review.verdict`, `review.gate`), so
  `pr-review-cli.js timing` does not read this runner's spans as stages. The span naming is PR #270's and is not changed
  here; this change emits no span of its own.

## Worked example

```bash
echo '{"repo":"acme/app","pr":42,"repoRoot":"/work/app"}' | node review-run-cli.js prepare
# {"ok":true,"status":"DISPATCH","runId":"pr42-3f2a9c1d7e04-1790000000","round":"review","wave":"1 of 1",
#  "maxConcurrentAgents":8,"agents":[{"name":"reviewer-s1-a","role":"reviewer","outPath":".../results/review/out-reviewer-s1-a.json",
#  "prompt":"...","deadlineAtIso":"..."}, ...], ...}
```

Start `reviewer-s1-a` and the other named agents with their `prompt` as given, then:

```bash
echo '{"repoRoot":"/work/app","runId":"pr42-3f2a9c1d7e04-1790000000"}' | node review-run-cli.js collect
# {"ok":true,"status":"DISPATCH","round":"verify","wave":"1 of 1", ...}   -> start the verifiers, collect again
# {"ok":true,"status":"PENDING","waitingOn":["verifier-2"],"retryAfterMs":15000, ...}   -> wait, collect again
# {"ok":true,"status":"ADJUDICATE","adjudicate":[{"id":"F3","why":"disputed"}], ...}
echo '{"repoRoot":"/work/app","runId":"pr42-3f2a9c1d7e04-1790000000","adjudications":[{"id":"F3","disposition":"deferred","reason":"Nit in an opt-in path, bead filed"}]}' | node review-run-cli.js collect
# {"ok":true,"status":"DONE","gate":{...},"reviewStatus":{"status":"REVIEW_PENDING", ...}, ...}
```

In full mode the last review wave is followed by a `TRIAGE` stop instead of verifiers:

```bash
echo '{"repoRoot":"/work/app","runId":"pr42-3f2a9c1d7e04-1790000000"}' | node review-run-cli.js collect
# {"ok":true,"status":"TRIAGE","candidates":[...],"reReview":{"scope":"first-review","reasons":[...]}, ...}   -> dispatch nothing
echo '{"repoRoot":"/work/app","runId":"pr42-3f2a9c1d7e04-1790000000","triage":{"additionalCandidates":[{"locationOrLink":"lib/a.js:12","failureMode":"a.js assumes b.js never returns null","severity":"important","evidence":"b.js:40 returns null on timeout"}]}}' | node review-run-cli.js collect
# {"ok":true,"status":"DISPATCH","round":"verify", ...}   -> the added candidate is verified like every other one
# or, instead of the call above when there is nothing to add (an empty list or {} means none):
echo '{"repoRoot":"/work/app","runId":"pr42-3f2a9c1d7e04-1790000000","triage":{}}' | node review-run-cli.js collect
```
