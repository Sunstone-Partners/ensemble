# Local CI Gate: Rollout and Rollback Runbook (TRD-010)

For a repository adopting the gate. The planning logic lives in
`local-ci-rollout.js` and is reached through the gate CLI's `rollout`
subcommand (`local-ci-cli.js rollout`), so it works from a checkout, a plugin
install or the Pi bundle. Locate the CLI exactly as the gate skill does
(`tool-path-resolution`); never hard-code a repo path. Send one JSON payload on
stdin: `{"action": "<name>", "input": {...}}` with `action` one of `snapshot`,
`plan-enable`, `plan-rollback`, `preconditions`. It only snapshots,
plans and checks; it never calls GitHub. A person with the rights named in
[Owner approvals](#owner-approvals) runs each call. The function names used
below (`snapshotProtection`, `planEnable`, ...) are what each action runs.

## Owner approvals

Each protection-changing step needs an admin of the adopting repository. The
list below is `OWNER_APPROVALS` in the library; a test checks every
protection-changing plan step is on it.

| Step | Approver | Needs approval | What is approved |
|---|---|---|---|
| `snapshot` | repository admin | no | read-only GET of the current protection |
| `first-success-status` | repository owner | yes | publishing the first real local-ci success, with the maintainer's own `gh` login, on a current head commit |
| `enable-protection` | repository admin | yes | local-ci check required by name, unpinned; hosted checks no longer required |
| `rollback-protection` | repository admin | yes | restoring the snapshot; hosted checks required again |

## Enable

Run in order; stop at the first refusal.

1. **Snapshot** (`snapshot`). Read the current protection and record it with
   `snapshotProtection(response, {repo, branch, now})`, then store the result
   somewhere durable (a file in the repo's ops notes, not a secret store; it
   holds no credential):
   `gh api repos/OWNER/REPO/branches/BRANCH/protection`.
   A malformed or partial response is refused, never snapshotted as a guess.
   The snapshot keeps `required_status_checks` (with `strict` and each check's
   `app_id`), `enforce_admins.enabled`, `required_pull_request_reviews`,
   `restrictions`, the repo, branch and timestamp.
2. **Preconditions.** `checkEnablementPreconditions({repoRoot, hasReportedSuccess})`
   must return `ok: true`. It refuses when any of these fails (all reasons listed):
   - the measurement note `MEASUREMENT.md` is missing, unfilled or `unmeasured` (TRD-013);
   - the local status context has not yet reported success on this repository;
   - `BASELINE.md` is missing.
3. **First real success status** (`first-success-status`). GitHub only allows a
   check to be required if it completed successfully in that repository within
   the past seven days. So, before touching protection, run the gate for a
   current head commit of the protected branch's PRs (`gate` mode of this skill)
   and let it post a real success with the maintainer's own `gh` login. Then set
   `hasReportedSuccess: true` for the step-2 check. Never post a status by hand.
4. **Enable protection** (`enable-protection`).
   `planEnable({snapshot, statusContext, replaces})` returns the calls as data.
   `statusContext` is `status_context` from `.ensemble/local-ci.yaml`; the check
   is added unpinned (`app_id: null`, written as `-1`).
   `replaces` is the list of currently required check names that the local gate
   covers (for this repository `validate`, `test (22)`, `test (24)`: the job
   names in the approval set, with ` (<node>)` for matrix entries). Only those
   are removed. Every other required check (a secret scan, a deploy preview)
   stays required, because the gate does not run it; the plan lists them under
   `keeps`. A name in `replaces` that is not currently required is refused, so a
   typo cannot leave a hosted check in place while enablement looks done.
   The one protection-changing call is
   `PATCH /repos/OWNER/REPO/branches/BRANCH/protection/required_status_checks`
   with body `{"strict": <snapshot strict>, "checks": [<kept checks with their app_id>, {"context": "<statusContext>", "app_id": -1}]}`.
   It replaces the list of required checks only, so `enforce_admins`, reviews and
   restrictions are untouched and `strict` is carried over.
   The `PUT .../protection` endpoint is deliberately not used: it replaces the
   whole protection and would drop anything the snapshot missed.
5. **Owner approval, apply, read back.** The repository admin reviews the plan
   and approves `enable-protection` (see [Owner approvals](#owner-approvals)),
   then applies the `PATCH`. Run the plan's read-only `GET .../protection` and
   confirm the local check is listed (reported with `app_id: null`), the hosted
   checks it replaced are gone, and everything else matches the snapshot.

## Trust model

The required check is **unpinned**: it is required by name, with no GitHub App
behind it (`app_id` is `null` when read and is written to GitHub as `-1`,
GitHub's documented "any app" value). The gate posts the status with the
maintainer's own `gh` login. Any identity with write access to the repository
can post a status under that name. `pr-merge` accepts one whose run record
verifies (head-SHA binding, runner blob hash, workflow-set hash, log digest,
review state); it does not verify who posted it. The gate therefore prevents
accidents and unverified agent merges. It does not stop deliberate forgery by
someone with write access. A repository that needs forge-resistance would need
a pinned GitHub App, which is separate future work and is not part of this gate.

## Hosted reuse (skip a local run that hosted CI already did)

When hosted CI has already passed on the PR's exact head, `gate` and `merge` can accept those results instead of repeating the work in a clean clone. The CLI reads them from GitHub itself (the Actions runs and jobs for that head SHA); the skill and the payload never supply them. Design and trust limits: TRD-015 in `docs/TRD/TRD-2026-4dec59b8-local-ci-pr-approval.md`.

**Enable.** Add a `hosted_reuse` block to `.ensemble/local-ci.yaml` on the base branch (it is read from the base ref, so it applies once merged):

```yaml
hosted_reuse:
  covers: [install, scripts-tests, validate, generate-validate, generated-drift, test]   # every name in `steps` (this repo lists nine)
  extra_workflows:
    - file: .github/workflows/generated-drift.yml
      jobs:
        - id: drift
```

Every step in `steps` MUST be listed in `covers`; if one is missing, reuse is off. `extra_workflows` names hosted jobs outside the default approval set. See the comment in this repository's `.ensemble/local-ci.yaml` for the exact current block.

**Disable.** Remove the `hosted_reuse` block, or delete one name from `covers` (an uncovered step turns reuse off entirely). Either is a normal reviewed change to the config.

**`forceLocal`.** `gate` accepts `forceLocal: true` (a boolean) in its payload to skip the hosted shortcut and run locally.

**Results.** `check`/`merge` and `gate` report `source:"hosted"` and `hostedJobs` when hosted results were accepted. `gate` then runs nothing and posts no status, so no `ensemble/local-ci` status exists for that head; `merge` accepts it all the same, and a verified local status still takes precedence when both exist.

**A refusal is not a failure.** A reason beginning `hosted CI not accepted:` means a hosted result could not be verified (job missing, still running, red, on another commit, a workflow file that differs from the base's, an underivable job name, GitHub unreachable). `gate` then runs locally exactly as before and reports `hostedRefused`; `merge` refuses and shows the hosted reason beside the local one. Run `gate` (or wait for hosted CI and check again).

**A PR that changes a workflow file.** Hosted CI ran the PR head's own copy of the workflow, so a PR that edits one of the hosted workflow files is refused for reuse and graded by the local gate; the change takes effect after it merges.

**Node 22 gap.** Hosted `validate` and `drift` run on Node 24 only, while the local gate runs 22 and 24; accepting hosted results gives up the Node 22 run of those steps, and `generate-validate` is declared covered by the generate step, which hosted `validate` and `drift` run. This is accepted in the config; delete the name from `covers` to refuse it.

**Not verified.** Who triggered the hosted run, and that the workflow's steps are honest beyond the file being identical to the base's. A `pull_request` run executes on the merge commit of head and base, not the bare head.

**Branch protection.** Never change branch protection from this skill, from the CLI or from any command. Since 2026-11-06 protection on `dev` requires the hosted checks `validate`, `test (22)` and `test (24)` (see Rollback), so GitHub itself waits for hosted CI. With reuse enabled, the gate verdict (`merge`) no longer needs a local gate run once those jobs are green on the head; it still refuses when they are not, and a PR whose workflow files changed is graded by the local gate. Pointing protection back at `ensemble/local-ci` stays a separate owner-approved step (see Enable).

## A PR branch that is behind its base is refused

The gate reads its configuration from the PR's **base** branch and compares the PR head's workflows with it. A PR whose
branch was cut before the base last changed a required workflow is therefore refused, not skipped: it reports
`unsupported-step` for every workflow step the base's configuration does not mirror, and posts nothing. This was seen on
the first real run against an open PR (a branch 116 commits behind `dev`, whose `test.yml` still had Python steps that
`dev` had since removed). The refusal is correct: the head's workflows are not the ones the gate was configured for.

What to do: have the PR author update the branch from the base (merge or rebase) and re-run. The operator should not
edit another author's branch. A refusal like this is not evidence the gate is broken, and it is not a reason to loosen
`.ensemble/local-ci.yaml`.

## Rollback

1. `planRollback({snapshot})` using the stored snapshot returns one
   protection-changing call (`rollback-protection`):
   `PATCH /repos/OWNER/REPO/branches/BRANCH/protection/required_status_checks`
   with the snapshot's `strict` and its original checks, each with its original
   `app_id` (an any-app check, recorded as `null`, is written back as `-1`).
   The hosted checks are required again and the local status is no longer required.
   Applying `planEnable` then `planRollback` to a protection store restores a
   protection equal to the snapshot (covered by a test against an in-memory store).
2. Run the plan's `GET` and compare it with the snapshot.
3. **`pr-merge` and bot reviews.** `pr-merge` classifies reviewers by account
   type; a bot's CHANGES_REQUESTED review and unresolved bot threads do not block
   its merge decision, and rolling back protection does not change that. What
   rolling back changes is the merge gate: GitHub itself again requires the
   hosted checks, so a PR without hosted CI success cannot merge even if the
   local gate passed. If `pr-merge` should also stop merging on the local status
   (so it waits for hosted CI again), revert the commit that changed
   `packages/git/commands/pr-merge.yaml` to merge on the gate verdict and
   regenerate; that is a separate, reviewed change.

## Optional pre-PR gate step (fix-issue, implement-trd-beads)

`fix-issue` and `implement-trd-beads` are unchanged. A caller that wants the PR
to open already approved runs, after the final commit and push of the branch and
before opening the PR: resolve the branch head SHA (full 40 hex), run the gate for
that head (`MODE=gate`, this skill), confirm `posted:true` and `mergeReady:true`,
then open the PR. The status is attached to the commit, so the PR's head carries
it from the moment it opens. If any commit is added afterwards the head moves and
the gate must run again; a status on an older commit never counts.
