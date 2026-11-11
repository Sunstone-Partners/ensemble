---
document_id: TRD-2026-4dec59b8
label: trd-local-ci-pr-approval
kind: trd
prd_reference: docs/PRD/PRD-2026-4dec59b8-local-ci-pr-approval.md
version: 1.0.13
status: Draft
date: 2026-10-22
design_readiness_score: 4.25
Constitution compliance: passed
---

# TRD-2026-4dec59b8: Local-CI PR Approval

Based on PRD: docs/PRD/PRD-2026-4dec59b8-local-ci-pr-approval.md (v1.0.5, Locked)

## Architecture Decision

**Chosen approach (Option C):** A `local-ci-gate` skill owns the editable procedure; a small set of pure-JS helpers in `packages/development/lib/` owns only what must be unforgeable; `pr-merge.yaml` invokes the skill.

- `packages/development/skills/local-ci-gate/SKILL.md` is the single reusable procedure and owns everything a maintainer would plausibly tune (Constitution Rule 8): the order of the run, the messages, the bead wording, and how failures are explained.
- Pure-JS modules in `packages/development/lib/` own only what grades a claim or protects a boundary (Rules 7 and 8's enforcement exception): run-record verification, bot-vs-human classification, bead dedupe keys, approval-set config validation, and status publishing through `gh`. They make no network calls except the one module whose purpose is to post a status.
- `packages/git/commands/pr-merge.yaml` calls the skill at its existing Merge phase. It does not restate gate logic.
- The gate runs in-session in the maintainer's own process. There is no daemon, scheduler or background sweep (Rule 4; REQ-012).

**Alternatives considered (user chose C):**

- **Option A -- prose-only:** fewest files, but head-binding, run-record verification and human/bot classification would be prose a model can misread, and tests could only assert wording. Rejected: the PRD's core property is that evidence cannot be reused across commits.
- **Option B -- TypeScript runtime in agent-core:** strongest typing, but adds a build/dist surface and pulls editable criteria toward code against Rule 8. Rejected: the one place a real client is tempting (posting a status) is a single `gh api` call.

**Dependency decision (user approved):** no new dependency. The status is posted by calling the maintainer's own `gh` CLI with an argv array (never a shell string), so there is no HTTP client, no JWT signing and no key handling. **Trust decision (user, 2026-10-22): no GitHub App; trust is honest-actor** (see Security design).

**Rationale:** Option C matches repository precedent (TRD-2026-82b6a138), keeps editable behavior out of TypeScript, and is the minimum code that makes the trust properties testable.

## Domain Analysis

| Domain | Present? | Notes |
|---|---|---|
| Skill/prompt content | Yes | New `local-ci-gate` skill; edits to `pr-merge.yaml`; per-repository config file |
| Library/CLI (Node.js) | Yes | `local-ci-*.js` modules and a `local-ci-cli.js` entry in `packages/development/lib/` |
| Data model | No | Per-run record is a status description string; the sweep ledger is bead labels. No schema/migration. |
| Infrastructure / external services | Yes | GitHub commit statuses through the maintainer's own `gh` login; Node (22 and 24) and git on the maintainer's machine; no Docker required |
| Security | Yes | Status forgery by any identity with write access (accepted limit); the maintainer's `gh` token; untrusted review text; secrets passed to local CI steps |
| Packaging/generation | Yes | Pi vendor bundle (`lib-bundler.ts` `ENTRY_FILES`), Pi/Codex/markdown generators |

**Greenfield or brownfield:** brownfield.

**COMPANION_DOMAINS:** empty. No persistence-schema change, and the architecture alternatives are recorded inline, not a vendor/tool comparison.

## Companion Artifacts

No companion artifacts generated.

## Reused Capabilities

No foundational TRD capabilities matched (`trd-graph-cli capabilities docs/TRD`). Existing code reused or deliberately not reused:

- **Reused:** the `tool-path-resolution` skill (locating `local-ci-cli.js` across checkout, plugin and Pi bundle); the `pr-review-state.js` `redact()` convention; the facts shape of `pr-review-remote.js` (reviews, comments, threads, check runs with `commitSha`) for the late-finding sweep input; **`scripts/ci-local.js` (`npm run ci:local`, PR #184 on `dev`)** as the CI execution engine, which already clones committed HEAD, runs `npm ci` and the test, validate, generate-validate and drift steps with `CI=true`, and is unit-tested and mutation-proven. The `act-local-ci` skill remains available for workflows `ci:local` does not mirror but is no longer on the critical path.
- **Deliberately not reused as a gate:** `pr-review-remote.js` `evaluateRemoteReview`. It is fail-closed and makes bot review blocking and head-bound, which is the opposite of REQ-006. It remains correct for `fix-issue` and `implement-trd-beads`, which this TRD does not change.

## System Architecture

### Components and boundaries

1. **`SKILL.md` (local-ci-gate)** -- orchestrates a gate run: resolves the PR, fetches the head SHA, delegates the clean clone and CI execution to the runner, calls the CLI to build and verify the run record, publishes the status, and reports. The only component that talks to `git` and `gh`.
2. **`local-ci-config.js`** -- validates the per-repository config (approval set, excluded jobs, status context name, bot-review handling, tracker). Fails closed on unknown or missing fields (AC-017-3).
3. **`local-ci-record.js`** -- builds and parses the run record carried in the status description (CI tool version, workflow-set hash, log digest) and verifies it against the PR head and configured set (AC-004-5, AC-004-6, AC-003-1/2).
4. **`local-ci-status.js`** -- the only network module: posts the commit status by calling `gh api repos/<owner>/<repo>/statuses/<sha>` with an argv array (never a shell string). Refuses to attest when there is no `gh` login or the post fails, redacts secrets, caps the description at 100 characters, and never reads, logs or stores the `gh` token (REQ-004, REQ-010).
5. **`local-ci-review.js`** -- classifies review authors by GitHub account `type` (Bot vs User), never by name, and decides whether a review set blocks (AC-006-3, AC-006-4).
6. **`local-ci-sweep.js`** -- given fetched facts about recently merged PRs, returns the bot findings and hosted-CI failures not yet tracked, using stable dedupe keys (AC-007-2, AC-008-3).
7. **`local-ci-cli.js`** -- JSON-in/JSON-out entry point wrapping the modules above, with boundary validation (Constitution Rule 2). Added to `lib-bundler.ts` `ENTRY_FILES` so Pi installs ship it.
8. **`pr-merge.yaml`** -- calls the skill in its Merge phase, replaces the `CHANGES_REQUESTED`/required-check refusal with the gate's verdict, and runs the sweep.

### Data flow

```
pr-merge -> local-ci-gate skill
  1. gh: PR head SHA, base, reviews   -> local-ci-cli review   (classify bot vs human; human CHANGES_REQUESTED blocks)
  2. git clone <tmp> @ <headSha>      -> the TRUSTED command list (from the base ref) run by the runner in <tmp>, once per required Node version; PASS/FAIL = exit status the runner observes
  3. step results + digest            -> local-ci-cli record   (build run record)
  4. record                           -> local-ci-status post  (gh api: POST status on headSha, maintainer's own gh login)
  5. gh: read status back             -> local-ci-cli verify   (record matches head + configured set)
  6. verified + no human block        -> gh pr merge
  7. post-merge                       -> local-ci-cli sweep    (open beads for new bot findings / CI failures)
```

### Integration points and failure handling

- **Status publish fails or no `gh` login:** the run may complete but publishes nothing and reports it cannot attest (AC-004-7); the merge is refused.
- **Prerequisite missing (git, Node, or the repository's CI entry point):** stop before any status is posted, naming the missing prerequisite (AC-015-2).
- **Head commit cannot be fetched:** stop, publish nothing (AC-003-4).
- **Verification mismatch (head or workflow set differs):** refuse the merge and print the mismatch (AC-004-6).
- **Unmirrored or unrunnable step:** a required workflow step that the configured step list does not mirror, or a required Node version that cannot be provided, fails the gate and names the step or version (AC-009-2).

### Security design

- The maintainer's `gh` token is never read, printed or stored by the gate: it stays inside `gh`, is not passed to CI steps, and `redact()` is applied to every string the CLI emits and strips token-shaped values and the values of `GH_TOKEN`/`GITHUB_TOKEN` (AC-010-2).
- **Trust model: honest-actor, stated plainly.** Branch protection may require the check `ensemble/local-ci` by name, unpinned (`app_id` null on read, written as `-1`, meaning any source). The verifier does not check who created a status (AC-004-4): a status for the configured context from any identity is accepted if its run record verifies against the PR head SHA, the workflow-set hash, the runner blob hash and the config blob hash. Anyone with write access can therefore forge a status; the gate prevents accidents and agents merging unverified work, not deliberate forgery. A pinned GitHub App could close this later and is out of scope.
- Review text and comment bodies are untrusted: only structured fields (author type, state, commit, thread resolved flag) are read for classification; bodies are passed to beads as quoted data, never interpreted.
- **Known limit (accepted in the PRD):** nothing proves the CI steps actually ran; the run record makes careless or stale posts detectable, not impossible.

### Hosted-result reuse (TRD-015, REQ-019)

Design as built. The local run is the approval signal; this section lets results hosted CI already produced for the same head stand in for it when, and only when, they can be verified from GitHub and the base ref without believing anything the PR head supplies.

- **Module and call sites.** `packages/development/lib/local-ci-hosted.js` exports `verifyHosted({repo, headSha, baseSha, repoRoot, approvalSet}, deps)`, pure over injected `deps` (`git`, and `ghApi(path)` returning `{ok, json | error}`). It runs nothing and posts nothing. The CLI queries GitHub itself; the payload never carries hosted data.
- **Opt-in: `hosted_reuse` in `.ensemble/local-ci.yaml`,** read from the base ref only (like every other key). `covers` lists the local step names hosted CI runs; `extra_workflows` lists `{file, jobs: [{id, matrix}]}` for hosted jobs outside the default approval set (here `generated-drift.yml`, job `drift`). `local-ci-config.js` turns it into `approvalSet.hostedReuse = {covers, checks}` or `null`. **Every name in `steps` must appear in `covers`**; otherwise the config does not validate for reuse and reuse is off, so adding a local step without declaring a hosted counterpart fails safe. Absent key: behaviour is unchanged.
- **Required job names are derived,** never read from the head: from the approval-set checks plus `extra_workflows`, as `<id>` or `<id> (<matrix values in key order>)` (for this repository `validate`, `test (22)`, `test (24)`, `drift`). If the base-ref workflow file gives the job a custom `name:`, it is used only when it is a plain literal (no `${{`) and the job has no matrix; any other custom name, or a job missing from the base workflow, refuses.
- **Workflow-file equality.** The git blob of each required workflow file at the PR head (`git rev-parse head:path`) must equal its blob at the base ref. Hosted CI executes the head's workflow, so a head that edited it could make `validate` pass trivially; with identical blobs the hosted command list is the one the base config was reviewed against. A PR that touches such a file is refused for reuse and graded locally, the same principle as base-ref config grading (the change applies after it merges).
- **Source of truth: the Actions API, not checks or statuses.** The CLI reads `GET repos/<repo>/actions/runs?head_sha=<head>` and `GET repos/<repo>/actions/runs/<id>/jobs`. Check runs and commit statuses are deliberately not used: a commit status is postable by anyone with write access, and a workflow holding `checks: write` can create a check run under the GitHub Actions app (app id 15368; per GitHub documentation, not probed here), so a name and app-id match would let a head-supplied workflow forge `validate`. Branch protection itself matches name and app id; this gate is stricter than that.
- **Run and job selection.** A run counts only if its `head_sha` equals the head, its `path` is the configured workflow file, its event is `pull_request` or `push`, and it is completed. Per (workflow file, event) only the latest run counts, so a re-run that went green replaces a red one and a later red replaces an earlier green. A `pull_request` run per workflow is required. Each required job must be present with the derived name, on the head, completed, with conclusion `success`. Missing, failed, cancelled, skipped, running, or truncated listings (more runs or jobs than were read) refuse.
- **Merge ordering (`merge`).** A verified local status still passes first and unchanged. Otherwise, if the base config opted in and `verifyHosted` succeeds, the result is `mergeReady:true, source:'hosted', hostedJobs`. Otherwise the merge is refused and the reason appends the hosted reason to the local one. Human `CHANGES_REQUESTED` still blocks as before.
- **Gate ordering (`gate`).** After the PR and config checks, before the gate lock and the clean clone: a hosted success returns `{stage:'hosted', ok:true, mergeReady:true, source:'hosted', hostedJobs, ranLocally:false}` with no lock taken, no run and no post (the check only reads GitHub, so it never queues behind a running gate). Missing, red, pending or unverifiable hosted results fall through to the local run exactly as before, which takes the lock (`local-ci-lock.js`) like any other run, with `hostedRefused` set. Payload key `forceLocal:true` (boolean) skips the shortcut.
- **Refusal reasons** all read `hosted CI not accepted: <reason>`: reuse not enabled; no GitHub lookup; head or base not a full SHA; no hosted jobs named; workflow file missing at base or different at the head; unreadable or invalid base workflow; job not defined; custom or computed job name; runs or jobs unreadable or truncated; no `pull_request` run; latest run or job not completed; required job missing; job not on the head; job concluded other than `success`.
- **Trust: what is verified.** The Actions service created these jobs (users cannot post Actions job objects), for the exact head SHA, from the named workflow path, under the derived names, and the workflow file equals the base's.
- **Trust: what is NOT verified or claimed.** Who triggered the run or posted anything; that the workflow's steps are honest beyond file equality (package scripts are head code, as in the local gate, which also runs head code); that a `pull_request` run, which executes on the merge commit of head and base at run time, matched the base as it is now (the run is attributed to the head SHA; not verifiable from the API); fidelity of hosted `validate` and `drift`, which run on Node 24 only where the local gate runs both 22 and 24 (accepted and declared in the config comment); and `generate-validate` (`npm run generate:validate`) is not a hosted step, so the config declares it covered by `npm run generate`, which hosted `validate` and `drift` both run and which validates the same YAML. To refuse reuse for any of these, delete the name from `covers`.
- **Rejected options.** (1, literal) Match check names from the checks API with nothing else: loses *no trust in the PR head*, since the name and app can be produced by a head-supplied workflow and a head can rewrite the workflow that produces the green, and it ignores steps hosted does not run. (2) `pr-merge.yaml` skips the gate when hosted is green: loses the CLI-computed verdict, base-ref grading and testability, because the decision would sit in prompt prose where nothing refuses a moved head, a red job or a config mismatch. (3) The local gate only as an opt-in fallback: leaves every PR paying the duplicate run by default; kept only as the fallback path and as `forceLocal`.
- **Non-goal.** No branch-protection call exists anywhere in this design, in code or in skills.

### Key risk, stated openly

The design rests on honest-actor trust, not on a forge-resistant mechanism (see Security design). One factual dependency is not yet observed: that an unpinned required check named `ensemble/local-ci` is satisfied by a commit status posted with `gh` on a real protected branch. TRD-010's runbook records that observation on the real repository (first real success status, then the requirement, then a PR seen blocked without the status and mergeable with it) and restores the pre-change snapshot if it does not hold.

## Master Task List

### PR 1: Gate Configuration
**Shippable State:** A repository has a validated, user-editable per-repository gate configuration (approval set, excluded jobs, status context, tracker) that fails closed when missing or malformed, so every later task has a trusted source for what the gate runs.

- [ ] **TRD-002** Per-repository gate configuration validator (`local-ci-config.js`) [satisfies REQ-009] [satisfies REQ-011] [satisfies REQ-017] (3h)
  - Target Files: `packages/development/lib/local-ci-config.js`, `.ensemble/local-ci.yaml`
  - Validates PRD ACs: AC-009-1, AC-009-3, AC-011-1, AC-017-1, AC-017-2, AC-017-3
  - Implementation AC:
    - [ ] Given a config naming workflows, jobs, matrix entries, excluded jobs and the status context (an unpinned name; the config carries no app id), when `validateConfig` runs, then it returns the normalized approval set
    - [ ] Given a config with an unknown key, a missing required key or a job both included and excluded, when it runs, then it returns `ok:false` naming each problem and never fills in another repository's defaults
    - [ ] Given no config file, when it runs, then it returns `ok:false` stating the config is missing
    - [ ] Given a repository with no bot reviewers configured, when it runs, then bot-review handling is marked skipped and the config is still valid

- [ ] **TRD-002-TEST** Gate configuration validation [Verifies TRD-002] [Satisfies REQ-009] [Satisfies REQ-011] [Satisfies REQ-017] [Depends: TRD-002] (3h)
  - Target Files: `packages/development/tests/local-ci-config.test.js`
  - Validates PRD ACs: AC-009-1, AC-009-3, AC-011-1, AC-017-1, AC-017-2, AC-017-3
  - Test AC:
    - [ ] Scenario: required checks are the approval set -- Given the Ensemble config, When validated, Then it names validate and test on Node 22 and 24
    - [ ] Scenario: excluded job recorded -- Given a codecov upload job in the excluded list, When validated, Then the exclusion appears in the normalized set
    - [ ] Scenario: edit changes behavior -- Given a maintainer removes a workflow from the file, When validated again, Then the set shrinks with no code change
    - [ ] Scenario: per-repo isolation -- Given two repository configs, When each is validated, Then neither contains the other's workflows
    - [ ] Scenario: missing config stops -- Given no config file, When validated, Then the result names the missing file and supplies no defaults
    - [ ] Scenario: no bot reviewers -- Given a repository without bot reviewers, When validated, Then bot handling is skipped without error

### PR 2: The Gate -- Run, Record, Publish, Verify
**Shippable State:** A maintainer can run the local gate on a PR and see a status on its head commit, posted with the maintainer's own `gh` login, carrying a verifiable run record; a stale or mismatched status is rejected whoever posted it, and a failing or unrunnable gate publishes nothing it cannot stand behind.

- [ ] **TRD-003** Run record builder and verifier (`local-ci-record.js`) [satisfies REQ-003] [satisfies REQ-004] (4h)
  - Target Files: `packages/development/lib/local-ci-record.js`
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-004-4, AC-004-5, AC-004-6
  - Implementation AC:
    - [ ] Given a runner identity, a workflow set and a log, when `buildRecord` runs, then it returns a description of at most 100 characters of the fixed form `ci-local <8-hex> | set:<8-hex> | log:<12-hex>` where the first field is the short git blob hash of the repository's `scripts/ci-local.js` at the PR head, with the log as a digest and never the log text and with the head SHA left implicit because the status is posted on that commit
    - [ ] Given a published description, when `parseRecord` runs, then it round-trips the same fields and rejects a malformed, over-length or truncated string
    - [ ] Given a record, the PR's current head SHA, the commit the status was posted on, and the configured workflow set, when `verifyRecord` runs, then it passes only when the status's commit equals the head SHA and the set hash recomputed from configuration equals `set:`
    - [ ] Given a status posted on commit A and a PR now at commit B, when it runs, then it returns `ok:false` with `headMismatch` naming both SHAs
    - [ ] Given a configured workflow set that has changed since the status was posted, when it runs, then it returns `ok:false` with `setMismatch` naming the difference
    - [ ] Given a status for the configured context posted by any identity (the maintainer, a collaborator, a personal token), when `verifyRecord` runs, then the creator is not consulted and the result depends only on the commit, the set hash and the record fields (AC-004-4, the stated honest-actor limit)

- [ ] **TRD-003-TEST** Run record binding [Verifies TRD-003] [Satisfies REQ-003] [Satisfies REQ-004] [Depends: TRD-003] (3h)
  - Target Files: `packages/development/tests/local-ci-record.test.js`
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-004-4, AC-004-5, AC-004-6
  - Test AC:
    - [ ] Scenario: record round trip -- Given a built record, When parsed, Then the runner identity, set hash and log digest all match
    - [ ] Scenario: new commit invalidates -- Given a passing record for A, When the PR head becomes B, Then verification fails naming A and B
    - [ ] Scenario: force-push invalidates -- Given a record and a head replaced by an unrelated commit, When verified, Then it fails
    - [ ] Scenario: workflow set drift -- Given a record whose set differs from the configured set, When verified, Then it fails and lists the difference
    - [ ] Scenario: log never embedded -- Given a log containing a token-shaped string, When the record is built, Then only a digest appears
    - [ ] Scenario: truncated record rejected -- Given a cut-off description, When parsed, Then it returns an error rather than partial fields
    - [ ] Scenario: over-length description rejected -- Given a description longer than 100 characters, When it is built or parsed, Then it is rejected and nothing longer than the bound is ever produced
    - [ ] Scenario: creator not consulted -- Given two identical records posted by different identities, When verified, Then both pass or fail identically and neither is judged by its author

- [ ] **TRD-014** gh-based status publisher (`local-ci-status.js`) [satisfies REQ-004] [satisfies REQ-010] [Depends: TRD-003] (4h)
  - Target Files: `packages/development/lib/local-ci-status.js`
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-7, AC-010-2
  - Implementation AC:
    - [ ] Given a repository `owner/repo`, a 40-hex head SHA, a state, a context and a run-record description, when `postStatus` runs, then it calls `gh api repos/<owner>/<repo>/statuses/<sha>` with an argv array (`execFile`-style, no shell, no string concatenation into a command line) carrying `state`, `context` and `description` as separate fields, after validating the SHA is exactly 40 hex characters and `owner/repo` matches `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`
    - [ ] Given a passing or failing gate result, when `postStatus` runs, then it posts `success` or `failure` respectively and rejects any other state before making a call
    - [ ] Given `gh` is not logged in (`gh auth status` exits non-zero) or `gh` is not installed, when `postStatus` runs, then it posts nothing and returns `{published:false, reason:'cannot attest'}` and the caller refuses the merge (AC-004-7)
    - [ ] Given `gh api` exits non-zero, times out, or returns a response that is not parseable JSON or whose `state` or commit does not match what was posted, when `postStatus` runs, then it returns `{published:false, reason:'post failed'}` with a redacted message and never reports success
    - [ ] Given a description longer than 100 characters (the bound TRD-003 enforces), when `postStatus` runs, then it is rejected before any call is made
    - [ ] Given any thrown error, stderr text or response containing a token-shaped string (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`) or the value of `GH_TOKEN` or `GITHUB_TOKEN`, when output is produced, then `redact` has removed it from every returned or logged string
    - [ ] Given the module is inspected, when it runs, then it never invokes `gh auth token` or `gh auth status --show-token`, never reads or writes a token file, and never places a token in a status, log, bead or argument list

- [ ] **TRD-014-TEST** gh status publisher posting, failing closed and secrecy [Verifies TRD-014] [Satisfies REQ-004] [Satisfies REQ-010] [Depends: TRD-014] (3h)
  - Target Files: `packages/development/tests/local-ci-status.test.js`
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-7, AC-010-2
  - Test AC:
    - [ ] Scenario: success status posted -- Given an injected `gh` runner and a passing result, When posted, Then the call is `gh api repos/<owner>/<repo>/statuses/<sha>` as an argv array with state success, the configured context and the run record
    - [ ] Scenario: failure status posted -- Given a failing result, When posted, Then the state is failure
    - [ ] Scenario: no shell string -- Given a context or repo containing shell metacharacters, When posted, Then it is rejected or passed as a single argv element and never interpreted by a shell
    - [ ] Scenario: bad SHA rejected -- Given a SHA that is not 40 hex characters, When posting is requested, Then no call is made
    - [ ] Scenario: no login publishes nothing -- Given `gh auth status` fails, When posting is requested, Then no status call is made and the result says it cannot attest
    - [ ] Scenario: post failure fails closed -- Given `gh api` exits non-zero or returns a mismatched response, When posting, Then the result is not published and never success
    - [ ] Scenario: over-length description rejected -- Given a 101-character description, When posting is requested, Then it is rejected and no call is made
    - [ ] Scenario: token never emitted -- Given stderr and a response containing a `ghp_` token and the `GH_TOKEN` value, When output is produced, Then neither value appears in any returned or logged string
    - [ ] Scenario: token commands never run -- Given a recording `gh` runner, When any post path runs, Then no `auth token` or `--show-token` invocation is recorded

- [ ] **TRD-012** Isolated gate runner (clean clone of the PR head, trusted command list, crash-safe cleanup) [satisfies REQ-003] [satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-015] [Depends: TRD-002] (5h)
  - Target Files: `packages/development/lib/local-ci-runner.js`
  - Validates PRD ACs: AC-003-3, AC-003-4, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Implementation AC:
    - [ ] Given a head SHA and the configured step list, when the runner executes, then it makes a clean clone under `.ensemble/local-ci-runs/<sha>`, checks out exactly that commit, and runs the trusted command list from the maintainer's config (read from the PR's base ref, never from the head) itself from inside that clone, grading only the exit status it observes and never loading or believing anything the head's own `ci:local` prints, so the commit under test is the PR head and never the maintainer's checked-out HEAD
    - [ ] Given uncommitted changes in the maintainer's working tree, when the runner executes, then those changes have no effect on the result
    - [ ] Given the head commit cannot be fetched, when the runner executes, then it returns an error naming the commit and publishes nothing
    - [ ] Given the configured required Node versions (22 and 24 for this repository), when the runner executes, then it runs the steps under each version explicitly (a Node bin directory pinned first on PATH) rather than the machine's default Node, and a required version that cannot be provided is a failure and never a skip
    - [ ] Given a required workflow step that the configured step list does not mirror (this repository's `validate.yml` also rejects Windows-invalid filenames and checks package.json consistency, neither of which `ci:local` runs), when the runner starts, then it either runs an equivalent configured command or fails naming the unmirrored step, and the gate never passes on a partial set
    - [ ] Given a step exits non-zero, when the run completes, then the result is a failure naming the step and the head SHA and is never reported as a pass
    - [ ] Given the runner is interrupted or crashes, when it exits or a later run starts, then the clone is removed in a finally-style cleanup, and a later run first removes clones under `.ensemble/local-ci-runs/` older than a threshold and touches nothing else
    - [ ] Given secrets are needed by a step, when the runner executes, then they come from a gitignored local file or the environment and never from a tracked file, and none appear in the returned result
    - [ ] Given the maintainer's `gh` token is in the environment (`GH_TOKEN`, `GITHUB_TOKEN`), when the runner executes steps, then neither variable reaches a step unless the base config's `secret_names` lists it, and the token value never appears in the returned result

- [ ] **TRD-012-TEST** Isolated runner [Verifies TRD-012] [Satisfies REQ-003] [Satisfies REQ-009] [Satisfies REQ-010] [Satisfies REQ-015] [Depends: TRD-012] (4h)
  - Target Files: `packages/development/tests/local-ci-runner.test.js`
  - Validates PRD ACs: AC-003-3, AC-003-4, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Test AC:
    - [ ] Scenario: runs the pushed commit -- Given a head SHA that is not the checked-out commit, When the runner executes, Then the clean clone is at that commit and the configured steps run there
    - [ ] Scenario: dirty tree ignored -- Given uncommitted edits locally, When the runner executes, Then the result reflects the pushed head only
    - [ ] Scenario: unfetchable head -- Given a head SHA that cannot be fetched, When the runner executes, Then it errors naming the SHA and publishes nothing
    - [ ] Scenario: failing step named -- Given a step that exits non-zero, When the runner executes, Then the result is a failure naming that step and the exact head SHA
    - [ ] Scenario: unmirrored workflow step fails the gate -- Given a required workflow step that is not in the configured step list, When the runner starts, Then it fails and names the unmirrored step instead of passing on a partial run
    - [ ] Scenario: node matrix honored -- Given a required Node matrix of 22 and 24, When the runner executes on a machine whose default Node is 26, Then each required version is run explicitly and a version that cannot be provided fails the gate
    - [ ] Scenario: crash leaves nothing behind -- Given the runner is killed mid-run, When a later run starts, Then the stale clone under the prefix is removed and nothing else is touched
    - [ ] Scenario: foreign directories untouched -- Given a maintainer-created directory outside the prefix, When cleanup runs, Then it is left alone
    - [ ] Scenario: secrets stay out -- Given a step that echoes a secret, When the result is returned, Then the secret value is absent
    - [ ] Scenario: gh token withheld -- Given `GH_TOKEN` set in the runner's environment and a step that prints its environment, When the runner executes, Then the step does not see it and the result does not contain its value

- [ ] **TRD-005** Gate skill and CLI (`local-ci-gate` skill, `local-ci-cli.js`) [satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-015] [Depends: TRD-002] [Depends: TRD-003] [Depends: TRD-014] [Depends: TRD-012] (4h)
  - Target Files: `packages/development/skills/local-ci-gate/SKILL.md`, `packages/development/lib/local-ci-cli.js`, `packages/pi/src/transformers/lib-bundler.ts`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-003-3, AC-003-4, AC-004-7, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Implementation AC:
    - [ ] Given a PR, when the skill runs, then it obtains a result from the TRD-012 runner for the exact head SHA and the configured approval set, and never runs CI or touches the working tree itself
    - [ ] Given Node, git or the configured CI entry point is unavailable, when the skill starts, then it stops before posting anything and names the missing prerequisite
    - [ ] Given a runner result that names a failing or unsupported step, when the skill reports, then it names the workflow, job and step and the exact head SHA and posts a failure status or nothing, never success
    - [ ] Given dry-run mode, when the skill completes, then it reports merge-readiness and posts nothing
    - [ ] Given the CLI receives malformed or oversized JSON, when it runs, then it rejects it at the boundary without side effects
    - [ ] Given `local-ci-cli.js` is added to `ENTRY_FILES`, when the Pi bundle is built, then it is present and resolvable through `tool-path-resolution`
    - [ ] Given the skill, when it runs a gate, then it delegates checkout, CI execution and cleanup to the runner from TRD-012 and itself only orders the steps, calls the CLI and reports
    - [ ] Given there is no `gh` login or the TRD-014 publisher reports `published:false`, when the skill reports, then it says it cannot attest, posts nothing else, and the merge is refused (AC-004-7)

- [ ] **TRD-005-TEST** Gate run end to end [Verifies TRD-005] [Satisfies REQ-001] [Satisfies REQ-002] [Satisfies REQ-003] [Satisfies REQ-009] [Satisfies REQ-010] [Satisfies REQ-015] [Depends: TRD-005] [Depends: TRD-012] (5h)
  - Target Files: `packages/development/tests/local-ci-gate-e2e.test.js`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-003-3, AC-003-4, AC-004-7, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Test AC:
    - [ ] Scenario: passing run merges -- Given a PR whose head has a verified passing status, When the flow runs, Then the merge proceeds without waiting for hosted CI
    - [ ] Scenario: no run refuses -- Given a PR with no local status, When the flow runs, Then the merge is refused and the missing run is reported
    - [ ] Scenario: missing prerequisite -- Given Node or the repository's CI entry point is missing, When the flow starts, Then it stops naming the missing prerequisite and does not fall back to merging
    - [ ] Scenario: dry run -- Given dry-run, When the flow completes, Then it reports readiness and merges and posts nothing
    - [ ] Scenario: failing step reported -- Given a failing test, When the gate runs, Then the report names workflow, job, step and head SHA
    - [ ] Scenario: runner failure never becomes success -- Given a runner result naming an unsupported step, When the skill reports, Then no success status is posted
    - [ ] Scenario: cannot attest refuses the merge -- Given the publisher reports no `gh` login or a failed post, When the flow runs, Then it reports it cannot attest and the merge is refused

- [ ] **TRD-006** Gate-can-fail proof (known-bad change) [satisfies REQ-005] [Depends: TRD-005] (3h)
  - Target Files: `packages/development/skills/local-ci-gate/PROOF.md`
  - Validates PRD ACs: AC-005-1, AC-005-2
  - Implementation AC:
    - [ ] Given a branch containing a deliberately failing test, when the gate runs, then it reports failure and publishes a failure status
    - [ ] Given the failing branch is reverted to a passing one, when the gate runs again, then it reports success, proving the check can both fail and pass
    - [ ] Given the proof is complete, when it is recorded, then the commands, outcomes and date are written to a proof note before the gate is enabled on any protected branch

- [ ] **TRD-006-TEST** Gate rejects a known-bad change [Verifies TRD-006] [Satisfies REQ-005] [Depends: TRD-006] [Depends: TRD-005] (3h)
  - Target Files: `packages/development/tests/local-ci-gate-can-fail.test.js`
  - Validates PRD ACs: AC-005-1, AC-005-2
  - Test AC:
    - [ ] Scenario: failing test blocks -- Given a PR with a failing test, When the gate runs, Then the status is failure and the PR is not approved
    - [ ] Scenario: fixed branch passes -- Given the same PR with the test fixed, When the gate runs, Then the status is success
    - [ ] Scenario: proof recorded -- Given the proof run, When the note is read, Then it lists both outcomes and no credential

### PR 3: Review Handling, Sweep and Merge Integration
**Shippable State:** A maintainer running `/ensemble:pr-merge` lands a PR on local evidence alone: bot reviews never hold it, a human reviewer's requested changes still do, and bot findings and post-merge hosted-CI failures are turned into beads by the next run without any background process.

- [ ] **TRD-007** Review author classification and block decision (`local-ci-review.js`) [satisfies REQ-006] (3h)
  - Target Files: `packages/development/lib/local-ci-review.js`
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3, AC-006-4
  - Implementation AC:
    - [ ] Given reviews with GitHub account types, when `classifyReviews` runs, then each author is Bot or User from the reported `type` field and never from the account name
    - [ ] Given a `CHANGES_REQUESTED` from a Bot and no human objection, when `decideBlock` runs, then it returns `blocked:false`
    - [ ] Given a `CHANGES_REQUESTED` from a User that is still that reviewer's standing review, when it runs, then it returns `blocked:true` naming the reviewer
    - [ ] Given a human whose latest decisive review is APPROVED or DISMISSED after an earlier request, when it runs, then it does not block
    - [ ] Given a review with an unreadable author type, when it runs, then it is treated as human (blocking direction) so an unknown can never silently pass

- [ ] **TRD-007-TEST** Bot reviews never block, human requests do [Verifies TRD-007] [Satisfies REQ-006] [Depends: TRD-007] (3h)
  - Target Files: `packages/development/tests/local-ci-review.test.js`
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3, AC-006-4
  - Test AC:
    - [ ] Scenario: bot request does not block -- Given a CodeRabbit-style Bot with CHANGES_REQUESTED, When decided, Then the merge is not blocked
    - [ ] Scenario: bot still reviewing -- Given a pending Bot review, When decided, Then the merge is not blocked and nothing waits
    - [ ] Scenario: human request blocks -- Given a User with CHANGES_REQUESTED, When decided, Then it is blocked and names that user
    - [ ] Scenario: name ignored -- Given a User account whose login ends in "[bot]", When classified, Then it is classified by its type field, not its name
    - [ ] Scenario: human re-approves -- Given a User who requested changes then approved, When decided, Then it does not block
    - [ ] Scenario: unreadable author is human -- Given a review with no author type, When decided, Then it blocks

- [ ] **TRD-008** Finding and CI-failure sweep (`local-ci-sweep.js`) [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-012] (5h)
  - Target Files: `packages/development/lib/local-ci-sweep.js`
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-008-1, AC-008-2, AC-008-3, AC-012-1, AC-012-2
  - Implementation AC:
    - [ ] Given fetched facts for recently merged PRs, when `findUntracked` runs, then it returns each unresolved Bot finding and each failed hosted-CI run not already represented by an existing bead
    - [ ] Given a finding, when its dedupe key is built, then the key is derived from the PR number, comment id or check run id and never from text, so re-running yields the same key
    - [ ] Given the same facts twice, when it runs twice, then the second run returns nothing new
    - [ ] Given no unresolved findings and no failures, when it runs, then it returns an empty result and the skill creates no beads
    - [ ] Given the module and skill, when inspected, then neither registers a timer, daemon, hook or schedule

- [ ] **TRD-008-TEST** Sweep dedupe and no background work [Verifies TRD-008] [Satisfies REQ-007] [Satisfies REQ-008] [Satisfies REQ-012] [Depends: TRD-008] (4h)
  - Target Files: `packages/development/tests/local-ci-sweep.test.js`
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-008-1, AC-008-2, AC-008-3, AC-012-1, AC-012-2
  - Test AC:
    - [ ] Scenario: unresolved findings become beads -- Given a merged PR with unresolved Bot threads, When swept, Then one bead per finding is returned linking its comment
    - [ ] Scenario: late finding found -- Given a finding posted after merge, When the next run sweeps, Then it is returned
    - [ ] Scenario: no duplicates -- Given findings already recorded, When swept again, Then nothing new is returned
    - [ ] Scenario: clean merge creates nothing -- Given no findings, When swept, Then the result is empty
    - [ ] Scenario: CI failure becomes a regression bead -- Given a failed hosted-CI run on a landed commit, When swept, Then a regression item linking the run is returned
    - [ ] Scenario: failure not duplicated -- Given a recorded failure, When swept again, Then nothing new
    - [ ] Scenario: hosted CI still runs on push -- Given the workflows, When their triggers are read, Then pull_request and push triggers are unchanged
    - [ ] Scenario: no background mechanism -- Given the new modules and skill, When scanned for timers, daemons and schedules, Then none exist

- [ ] **TRD-009** Integrate the gate into `pr-merge.yaml` and regenerate [satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-006] [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-015] [Depends: TRD-005] [Depends: TRD-007] [Depends: TRD-008] (5h)
  - Target Files: `packages/git/commands/pr-merge.yaml`
  - Validates PRD ACs: AC-001-1, AC-002-1, AC-004-4, AC-006-1, AC-006-3, AC-007-1, AC-008-1
  - Implementation AC:
    - [ ] Given `pr-merge.yaml`, when edited, then the NEVER-merge-on-CHANGES_REQUESTED and required-checks constraints are replaced by the gate's verdict and the human-review block, and the dry-run, max-rounds and no-test-weakening constraints are preserved unchanged
    - [ ] Given the Merge phase, when it runs, then it calls the `local-ci-gate` skill and does not restate gate logic
    - [ ] Given the sweep, when the merge flow starts, then it runs the sweep before merging and after merging, and records beads through `br`
    - [ ] Given the YAML source changed, when `npm run generate`, `npm run generate:codex` and the Pi generator run, then every generated `pr-merge` artifact reflects the change and `npm run generate:validate` passes
    - [ ] Given `fix-issue` and `implement-trd-beads`, when this change lands, then their review gates are untouched
    - [ ] Given a status for the configured context, when the merge flow evaluates readiness, then it accepts or refuses it by `verifyRecord` alone and does not accept or reject it on the identity that posted it (AC-004-4), and a PR with only hosted-CI success and no local status is refused (AC-004-3)

- [ ] **TRD-009-TEST** pr-merge integration and generation parity [Verifies TRD-009] [Satisfies REQ-001] [Satisfies REQ-002] [Satisfies REQ-006] [Satisfies REQ-007] [Satisfies REQ-008] [Satisfies REQ-015] [Depends: TRD-009, TRD-007, TRD-008, TRD-005] (4h)
  - Target Files: `packages/development/tests/local-ci-pr-merge-integration.test.js`
  - Validates PRD ACs: AC-001-1, AC-002-1, AC-004-4, AC-006-1, AC-006-3, AC-007-1, AC-008-1
  - Test AC:
    - [ ] Scenario: gate precedes merge -- Given the generated command, When its phases are read in order, Then the gate runs before the merge step
    - [ ] Scenario: bot review no longer refuses -- Given the generated constraints, When read, Then CHANGES_REQUESTED from a bot is not a refusal condition and a human one still is
    - [ ] Scenario: safety constraints preserved -- Given the generated constraints, When read, Then no-test-weakening, no force-push and max-rounds remain
    - [ ] Scenario: sweep runs around merge -- Given the generated phases, When read, Then the sweep appears before and after the merge
    - [ ] Scenario: runtimes agree -- Given the Pi, Codex and markdown outputs, When compared, Then all contain the same gate and review rules
    - [ ] Scenario: other commands untouched -- Given fix-issue and implement-trd-beads, When their generated output is compared before and after, Then it is identical
    - [ ] Scenario: author not consulted -- Given the generated skill and constraints, When read, Then readiness depends on the verified run record and not on the status creator, and no GitHub App id or creator check appears

### PR 4: Rollout, Rollback and Measurement
**Shippable State:** A maintainer can enable the gate on a repository's protected branch by following a documented procedure, roll back to hosted CI and bot-review gating with a documented procedure, and has a recorded baseline of PR open-to-merge times captured before enablement.

- [ ] **TRD-013** Local gate speed and fidelity measurement [satisfies REQ-013] [satisfies REQ-009] [Depends: TRD-012] (4h)
  - Target Files: `packages/development/skills/local-ci-gate/MEASUREMENT.md`, `packages/development/lib/local-ci-timing.js`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-009-1
  - Implementation AC:
    - [ ] Given the configured step list and required Node versions, when the gate runs cold (no dependency cache, Node not yet downloaded) and warm, then both durations are recorded per Node version beside the hosted CI durations for the same workflows over the same period
    - [ ] Given the local and hosted results for the same head commit, when they are compared, then any job that passes in one and fails or cannot run in the other is listed as a fidelity gap
    - [ ] Given the recorded comparison, when a repository is about to enable the gate, then the runbook requires the measurement note to exist and states plainly whether the local gate is faster, slower or equal to hosted CI, with no target asserted
    - [ ] Given the comparison shows the local gate is slower than hosted CI, when the maintainer reads the note, then it states that the benefit for that repository comes from removing the bot-review wait and not from run time

- [ ] **TRD-013-TEST** Speed and fidelity measurement honesty [Verifies TRD-013] [Satisfies REQ-013] [Satisfies REQ-009] [Depends: TRD-013] (3h)
  - Target Files: `packages/development/tests/local-ci-timing.test.js`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-009-1
  - Test AC:
    - [ ] Scenario: cold and warm recorded -- Given two timed runs, When the note is produced, Then both durations appear next to the hosted figure
    - [ ] Scenario: fidelity gap listed -- Given a job that passes hosted and fails locally, When compared, Then it is listed as a gap
    - [ ] Scenario: slower is stated -- Given local slower than hosted, When the note is read, Then it says slower and does not claim a speedup from run time
    - [ ] Scenario: enablement requires the note -- Given no measurement note, When the runbook gate check runs, Then enablement is refused

- [ ] **TRD-010** Rollout and rollback runbook with protection changes [satisfies REQ-004] [satisfies REQ-014] [satisfies REQ-016] [Depends: TRD-009] [Depends: TRD-013] (4h)
  - Target Files: `packages/development/skills/local-ci-gate/RUNBOOK.md`, `packages/development/skills/local-ci-gate/SKILL.md`
  - Validates PRD ACs: AC-004-3, AC-014-1, AC-016-1
  - Implementation AC:
    - [ ] Given a repository adopting the gate, when the runbook is followed, then branch protection requires the local status as an UNPINNED required check named `ensemble/local-ci` (read back as `app_id: null`, written to GitHub as `-1`, meaning any source) and the hosted checks are no longer required, with the exact API calls and a pre-change snapshot of the existing protection recorded first
    - [ ] Given the local-ci status context has not yet reported successfully on the real repository, when the runbook is followed, then it first posts a real success status on a current head commit, because GitHub only allows a check to be required if it completed successfully in that repository within the past seven days, and only then edits branch protection
    - [ ] Given the gate was enabled, when the rollback section is followed, then protection is restored from the snapshot, hosted checks are required again, and `pr-merge` honors bot reviews as before
    - [ ] Given `fix-issue` or `implement-trd-beads` is about to open a PR, when the optional gate step is used, then the PR opens with the status already published for its head
    - [ ] Given protection changes need an admin, when the runbook is read, then it names which step each adopting repository's owner approves
    - [ ] Given the TRD-013 measurement note does not exist for the repository, when the runbook reaches enablement, then it stops and refuses to proceed
    - [ ] Given no pre-change protection snapshot exists, when the runbook reaches the protection edit, then it stops and refuses to proceed
    - [ ] Given the runbook is read, when it describes the check, then it states plainly that trust is honest-actor: any identity with write access can post a status under that name, `pr-merge` accepts it only if the run record verifies, and a pinned GitHub App is a separate, out-of-scope option for teams that need forge-resistance
    - [ ] Given protection has been edited, when the runbook verifies it, then it reads the protection back, records that the `ensemble/local-ci` check carries no app pin, and records a PR observed blocked without the status and mergeable with a verified one

- [ ] **TRD-010-TEST** Rollback restores prior protection [Verifies TRD-010] [Satisfies REQ-004] [Satisfies REQ-014] [Satisfies REQ-016] [Depends: TRD-010] (3h)
  - Target Files: `packages/development/tests/local-ci-rollback.test.js`
  - Validates PRD ACs: AC-004-3, AC-014-1, AC-016-1
  - Test AC:
    - [ ] Scenario: enable then rollback is lossless -- Given a protection snapshot, When the gate is enabled then rolled back, Then protection equals the snapshot
    - [ ] Scenario: hosted checks required again -- Given a rolled-back repository, When a PR has no hosted CI success, Then it cannot merge
    - [ ] Scenario: PR born approved -- Given the optional gate step, When a PR is opened by fix-issue, Then its head already carries the status
    - [ ] Scenario: unpinned check written -- Given the protection payload the runbook builds, When inspected, Then it requires `ensemble/local-ci` with `app_id: -1`, the hosted checks are absent, and no other source is named
    - [ ] Scenario: enablement refused without a snapshot -- Given no pre-change snapshot, When the runbook gate check runs, Then the protection edit is refused
    - [ ] Scenario: enablement refused before the first success status -- Given the context has never reported success on the repository, When the runbook gate check runs, Then it posts a real success status first and edits protection only afterwards

- [ ] **TRD-011** Baseline capture and success-target recording [satisfies REQ-013] (4h)
  - Target Files: `packages/development/lib/local-ci-baseline.js`, `packages/development/skills/local-ci-gate/BASELINE.md`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-013-3
  - Implementation AC:
    - [ ] Given a cohort window, when the baseline script runs, then it reports median and p75 open-to-merge time and, separately, the wait attributable to hosted CI and to bot review
    - [ ] Given the gate is not yet enabled, when the baseline is captured, then the cohort and its figures are written to a recorded note before enablement
    - [ ] Given post-change data below the agreed minimum, when status is reported, then the target is stated as unproven and never as met
    - [ ] Given the baseline exists, when the target and minimum post-change cohort are decided, then they are recorded in the PRD changelog

- [ ] **TRD-011-TEST** Baseline reporting honesty [Verifies TRD-011] [Satisfies REQ-013] [Depends: TRD-011] (3h)
  - Target Files: `packages/development/tests/local-ci-baseline.test.js`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-013-3
  - Test AC:
    - [ ] Scenario: median and p75 reported -- Given a fixed set of PR timings, When the report runs, Then median and p75 match a hand computation
    - [ ] Scenario: waits split -- Given CI and bot-review durations, When reported, Then each is attributed separately
    - [ ] Scenario: insufficient data is unproven -- Given too few post-change PRs, When status is reported, Then it says unproven
    - [ ] Scenario: baseline precedes enablement -- Given the gate is not enabled, When the baseline note is read, Then it carries a capture date earlier than any enablement record


- [ ] **TRD-015** Hosted-result reuse (`local-ci-hosted.js`, `hosted_reuse` config key, `merge` and `gate` integration) [satisfies REQ-019] [Depends: TRD-002] [Depends: TRD-005] (6h)
  - Target Files: `packages/development/lib/local-ci-hosted.js`, `packages/development/lib/local-ci-config.js`, `packages/development/lib/local-ci-cli.js`, `.ensemble/local-ci.yaml`
  - Validates PRD ACs: AC-019-1, AC-019-2, AC-019-3, AC-019-4, AC-019-5, AC-019-6
  - Implementation AC:
    - [ ] Given a base-ref config with `hosted_reuse` and every required job completed with conclusion success on the exact head in the latest `pull_request` run of its workflow, when `merge` or `gate` runs, then the result is merge-ready with `source:'hosted'` and, for `gate`, nothing is run or posted
    - [ ] Given a missing, running, failed, cancelled, skipped, truncated or other-commit hosted job, when `gate` runs, then it runs locally with `hostedRefused` set, and when `merge` runs it refuses with the hosted reason appended to the local one
    - [ ] Given a required workflow file whose blob differs between the PR head and the base ref, when reuse is evaluated, then it is refused
    - [ ] Given no `hosted_reuse` key, or a `steps` entry missing from `covers`, when reuse is evaluated, then reuse is off and behaviour is unchanged
    - [ ] Given check runs or commit statuses named like the required jobs, when reuse is evaluated, then they are ignored because only Actions runs and jobs are read
    - [ ] Given `forceLocal:true`, when `gate` runs, then the hosted shortcut is skipped
    - [ ] Given hosted results are accepted, when `gate` runs, then the gate lock is never asked for, so it does not queue behind a running gate; given they are not accepted (or `forceLocal:true`, or no opt-in), then the local run takes the lock like any other run

- [ ] **TRD-015-TEST** Hosted reuse verification and refusal [Verifies TRD-015] [Satisfies REQ-019] [Depends: TRD-015] (4h)
  - Target Files: `packages/development/tests/local-ci-hosted*.test.js`
  - Validates PRD ACs: AC-019-1, AC-019-2, AC-019-3, AC-019-4, AC-019-5, AC-019-6
  - Test AC:
    - [ ] Scenario: hosted green is reused -- Given all required jobs green on the head, When `gate` runs, Then it returns `source:'hosted'` and runs and posts nothing
    - [ ] Scenario: red, pending or missing job refuses -- Given a failed, running or absent required job, When reuse is evaluated, Then it refuses with a reason and `gate` falls through to the local run
    - [ ] Scenario: latest run wins -- Given a red run later superseded by a green re-run and the reverse, When evaluated, Then only the latest run per workflow and event counts
    - [ ] Scenario: workflow edited by the PR -- Given a head blob that differs from the base blob, When evaluated, Then reuse is refused
    - [ ] Scenario: forged check or status ignored -- Given a success check run or status with the required name and no Actions job, When evaluated, Then reuse is refused
    - [ ] Scenario: not opted in or uncovered step -- Given no `hosted_reuse` or a step missing from `covers`, When evaluated, Then reuse is off
    - [ ] Scenario: forceLocal -- Given hosted green and `forceLocal:true`, When `gate` runs, Then it runs locally
    - [ ] Scenario: merge ordering -- Given a verified local status and a red hosted job, When `merge` runs, Then the local status wins; given neither, Then the refusal carries both reasons
    - [ ] Scenario: hosted check precedes the lock -- Given hosted green and a lock held by another live process, When `gate` runs, Then it returns `source:'hosted'` at once and leaves the lock untouched; given hosted refused, Then it stops at `stage:'lock'` with `hostedRefused` set and runs nothing

## Acceptance Criteria Traceability

| REQ | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Local run approves a PR | TRD-005, TRD-009 | TRD-005-TEST, TRD-009-TEST |
| REQ-002 | The merge command is the entry point | TRD-005, TRD-009 | TRD-005-TEST, TRD-009-TEST |
| REQ-003 | Evidence is bound to the exact head commit | TRD-003, TRD-005, TRD-012 | TRD-003-TEST, TRD-005-TEST, TRD-012-TEST |
| REQ-004 | Evidence is published where the merge flow and branch protection can see it | TRD-003, TRD-005, TRD-009, TRD-010, TRD-014 | TRD-003-TEST, TRD-005-TEST, TRD-009-TEST, TRD-010-TEST, TRD-014-TEST |
| REQ-005 | The gate can fail | TRD-006 | TRD-006-TEST |
| REQ-006 | Bot reviews become non-blocking; human reviews still block | TRD-007, TRD-009 | TRD-007-TEST, TRD-009-TEST |
| REQ-007 | Bot review findings become tracked work | TRD-008, TRD-009 | TRD-008-TEST, TRD-009-TEST |
| REQ-008 | Hosted CI remains a safety net | TRD-008, TRD-009 | TRD-008-TEST, TRD-009-TEST |
| REQ-009 | The local run covers what hosted CI covers | TRD-002, TRD-005, TRD-012, TRD-013 | TRD-002-TEST, TRD-005-TEST, TRD-012-TEST, TRD-013-TEST |
| REQ-010 | Local run must not leak secrets | TRD-005, TRD-012, TRD-014 | TRD-005-TEST, TRD-012-TEST, TRD-014-TEST |
| REQ-011 | Behavior is user-editable, not hardcoded | TRD-002 | TRD-002-TEST |
| REQ-012 | No second dispatcher | TRD-008 | TRD-008-TEST |
| REQ-013 | Cycle-time improvement is measured, not assumed | TRD-011, TRD-013 | TRD-011-TEST, TRD-013-TEST |
| REQ-014 | Rollback to remote gating | TRD-010 | TRD-010-TEST |
| REQ-015 | Clear failure reporting | TRD-005, TRD-009, TRD-012 | TRD-005-TEST, TRD-009-TEST, TRD-012-TEST |
| REQ-016 | Applies to the PR-producing commands' boundaries | TRD-010 | TRD-010-TEST |
| REQ-017 | Per-repository configuration | TRD-002 | TRD-002-TEST |
| REQ-019 | Reuse hosted CI results for the same head | TRD-015 | TRD-015-TEST |

## Sprint Planning

Informational only; `implement-trd-beads` does not parse this section.

## Sprint 1: Build the gate
- PR 1 (TRD-002) -- 6h including tests.
- PR 2 (TRD-003, TRD-014, TRD-012, TRD-005, TRD-006) -- 38h including tests.

## Sprint 2: Integrate and roll out
- PR 3 (TRD-007 to TRD-009) -- 24h including tests.
- PR 4 (TRD-013, TRD-010, TRD-011, TRD-015) -- 31h including tests. TRD-013 precedes TRD-010 because the runbook refuses enablement without the measurement note.

## Architecture Self-Critique

1. **Gap, trust and sequencing (resolved by user decision, 1.0.12):** earlier versions required a maintainer-owned GitHub App, a live proof (TRD-001) that an App-posted status satisfies an App-pinned check, and an App client (TRD-004). The user removed the App because creating, installing and holding a key for it was a barrier to entry. The status is now posted with the maintainer's own `gh` login (TRD-014), the required check is unpinned, and trust is honest-actor: any identity with write access can post a status, and the gate accepts it only if the run record verifies. TRD-001, TRD-001-TEST, TRD-004 and TRD-004-TEST are deleted; the statements about them in 1.0.1, 1.0.6 and 1.0.8 are superseded. What stays unproven is that an unpinned required check is satisfied by a `gh` status on the real repository and the longest description GitHub accepts (TRD-014 enforces 100, below the working limit of 140); TRD-010's runbook observes the first at enablement.
2. **Gap, contradiction with an existing module:** `pr-review-remote.js` classifies bots by a configured login list, while PRD AC-006-4 requires classification by GitHub account type. Resolution: TRD-007 is a separate module that reads `type`; `pr-review-remote.js` is left untouched because `fix-issue` and `implement-trd-beads` still depend on its fail-closed behavior.
3. **Gap, tracker coupling:** The sweep creates beads through `br`, which exists in this repository but not necessarily in an adopting repository such as Foreman. Resolution: the tracker is a config field (TRD-002); the sweep returns structured items, and the skill hands them to whichever tracker the config names.
4. **Missing failure path:** if the status is posted but the PR head moves before the merge call, the merge could race. Resolution: the merge step re-reads the head SHA and re-verifies immediately before calling `gh pr merge` (TRD-005, TRD-009).

## Dependency and Estimate Review

- **Longest chain:** TRD-003 -> TRD-014 -> TRD-005 -> TRD-009 -> TRD-010 -> TRD-010-TEST (depth 6; TRD-002 -> TRD-012 -> TRD-005 -> TRD-009 -> TRD-010 -> TRD-010-TEST is an equally long alternative). Computed by walking the `dependsOn` arrays from `trd-cli.js parse`: 30 declared edges, no forward dependencies, no cycles (earlier rows of this document said 31 edges; the same count over the previous version gives 30). The chain no longer starts with a human-assisted proof, so no task on it needs anything only the maintainer can create. Three orderings were deliberately left undeclared because the tasks can be built and tested independently: TRD-007 and TRD-008 on TRD-002 (both are pure modules tested with fixtures), and TRD-011 on TRD-013 (they share only a recording location).
- **Estimate risk:** TRD-012 (5h) bundles the clean clone of an arbitrary head commit, running the repository's `ci:local` under each required Node version, mirroring the `validate.yml` steps `ci:local` omits, and crash-safe cleanup. The Node-version provisioning (`ci:local --node` downloads Node and does not work offline unless cached) is the most likely to overrun. TRD-005 was reduced to 4h by moving the runner out.
- **Estimate consistency:** the module tasks (TRD-002, 003, 007) are 3-4h; the I/O or external-system tasks are TRD-014 (4h) and TRD-008 and TRD-012 (5h).

## Testability Review

- Every implementation task has a paired `-TEST` task with one Scenario per validated AC group.
- TRD-006 is a proof against a real failing test and cannot be satisfied by mocks, which is deliberate (Constitution Rule 7). The first real success status and the protection read-back in TRD-010 are exercised against injected GitHub responses in tests and against the real repository only at enablement.
- Secret handling (REQ-010) is covered by the redaction and token-command scenarios in TRD-014-TEST and the `GH_TOKEN` scenario in TRD-012-TEST. With no App there is no private key and no rotation procedure.

## Design Readiness Gate

| Dimension | Score | Note |
|---|---|---|
| Architecture completeness | 4 | Components, data flow, failure handling, security design and the runner boundary are defined; the trust model is stated as honest-actor, the status description is capped at 100 characters (below the working 140 limit, unconfirmed against GitHub), and whether an unpinned required check is satisfied by a `gh` status is observed at enablement (TRD-010). |
| Task coverage | 4 | All 18 requirements (REQ-018 deleted, REQ-019 added in 1.0.13) have implementation and test tasks (matrix regenerated from task annotations). Nine requirements have fewer than 3 PRD ACs (REQ-001, 002, 005, 010, 011, 012, 014, 015, 016), below create-trd's BDD minimum; recorded here instead of editing the locked PRD. |
| Dependency clarity | 5 | Dependencies are declared on every implementation task that has a prerequisite; the graph is acyclic, has no forward dependencies, and the longest chain is computed in the Dependency and Estimate Review. |
| Estimate confidence | 4 | Granular and consistent after splitting the runner out of TRD-005; the cost of a clean clone plus `npm ci` per required Node version, and the unmirrored `validate.yml` steps, remain the main uncertainty and now have a measuring task (TRD-013). |

**Overall: 4.25 (PASS).** Previous: 4.0.

## Notes

- **Total tasks:** 26 (13 implementation, 13 test). **Total estimate:** 99h (PR 1: 6h, PR 2: 38h, PR 3: 24h, PR 4: 31h). Checked against `trd-cli parse` (26 tasks, 13 and 13; phase sums 6, 38, 24 and 31 hours, no warnings) when TRD-015 was landed.
- **Constitution compliance:** passed (`docs/standards/constitution.md`). Rule 1 (no secrets): TRD-014 owns the never-handle-the-`gh`-token rule and redaction; TRD-012 keeps workflow secrets and `GH_TOKEN` out of steps and results. Rule 2 (input validation): TRD-005 CLI boundary and TRD-002 config validation. Rule 3 (tests accompany features): every task has a `-TEST` pair. Rule 4 (no second dispatcher): TRD-008 and REQ-012. Rule 6 (reachable from entry point): TRD-009 wires the gate into `pr-merge`. Rule 7 (a check can fail): TRD-006. Rule 8 (user-editable behavior in skills): the skill and config own procedure and policy. Rule 9: no test pins another actor's write order.
- **Open decision carried forward:** the numeric cycle-time target and minimum post-change cohort are set after the baseline (TRD-011), per PRD REQ-013.
- **Status description and head SHA (resolved by PRD 1.0.2):** GitHub's status description is length-capped (working limit 140 characters, unconfirmed in current documentation), so TRD-003 bounds the record at 100 characters, TRD-014 refuses anything longer, the head SHA is carried implicitly by the commit the status is posted on, and `verifyRecord` checks that commit. PRD AC-004-5 was reworded in v1.0.2 to say exactly this, so this is no longer an interpretation of the PRD but its stated requirement.
- **Departure from the literal request, by user decision:** the original request said to run CI locally "using act". `dev` already ships `npm run ci:local`, a tested clean-clone runner (PR #184), and the user chose to wrap it instead of building an `act` runner. The `act-local-ci` skill is unchanged and remains available for repositories or workflows `ci:local` does not mirror.
- **PRD wording aligned (resolved):** PRD-2026-4dec59b8 originally named `act` and a container runtime (Solution text, AC-004-5, AC-009-2, AC-015-2) while this TRD uses `ci:local`. At the user's request the PRD was re-locked at v1.0.2 with runner-neutral wording, with the same 18 requirements and 47 acceptance criteria (PRD 1.0.4 has 17 and 45 after the GitHub App and REQ-018 were removed). The beads that quote those three criteria were refreshed to match. AC-004-5 now names the runner identity and states that the head SHA is established by the commit the status is posted on, which also removes the earlier PRD-versus-TRD interpretation in the note above.
- **Measured premise check (2026-10-21):** hosted required CI on this repository takes about 2.5 to 3 minutes (`test` 153-192s, `validate` 44-62s, run in parallel). A local run through `ci:local` is a sequential install, scripts-tests, validate, generate-validate, drift and test on one Node version at a time, so it is unlikely to be faster than hosted CI, especially across the Node 22 and 24 matrix. TRD-013 measures this before any repository enables the gate; the speedup for a repository comes from removing the bot-review wait, not from run time.

## Changelog

| Date | Version | Change |
|---|---|---|
| 2026-10-21 | 1.0.0 | Initial TRD created from PRD-2026-4dec59b8 v1.0.1. Design readiness 4.0. |
| 2026-10-21 | 1.0.1 | Refinement (8 findings, all addressed): declared `[Depends:]` on implementation tasks so TRD-001 genuinely gates TRD-004 (previously prose only; parsed chain depth was 2, not the claimed 6); compact run record (act version, 8-hex set hash, 12-hex log digest, at most 100 characters) with the head SHA carried by the commit the status is posted on, because the status description is length-capped; split the isolated runner out of TRD-005 into new TRD-012 with crash-safe cleanup that touches only this tool's labelled leftovers; added TRD-013 to measure local gate speed and fidelity against hosted CI before any repository enables the gate (hosted CI measured at about 3 minutes, so the local gate is unlikely to be faster); added first-real-post-before-protection-edit ordering to TRD-010 for GitHub's seven-day rule on required checks; added a tracked-credential preflight to TRD-004; regenerated the traceability matrix from task annotations; corrected task count (26), hours (97) and the longest chain. Design readiness 4.0 to 4.25. |
| 2026-10-21 | 1.0.2 | Found while scaffolding beads: TRD-009 declared no dependencies although its acceptance criteria call the gate skill (TRD-005), the review decision (TRD-007) and the sweep (TRD-008), so the bead graph would have allowed the pr-merge integration to be scheduled first. Added `[Depends: TRD-005]`, `[Depends: TRD-007]` and `[Depends: TRD-008]`. Audited 16 intended orderings: 10 were already declared, 3 were this fix, and 3 (TRD-007 and TRD-008 on TRD-002, TRD-011 on TRD-013) were deliberately left undeclared because those tasks can be built and tested independently. The computed longest chain is now depth 6 (TRD-001 -> TRD-004 -> TRD-005 -> TRD-009 -> TRD-010 -> TRD-010-TEST). No forward dependencies, no cycles, 31 declared edges. |
| 2026-10-21 | 1.0.3 | Rebased onto `dev` (the real integration branch; the TRD had been written against `main`, 75 commits behind) and replaced the `act` runner with the repository's own `npm run ci:local` (`scripts/ci-local.js`, PR #184), by user decision. `ci:local` has no way to test a named commit and always tests the invoking repo's checked-out HEAD, and it runs one Node version at a time, so TRD-012 now clones the PR head into a clean directory and runs `ci:local` from inside it once per required Node version (22 and 24; the maintainer machine runs Node 26, which is not in the matrix). `validate.yml` also rejects Windows-invalid filenames and checks package.json consistency, which `ci:local` does not run, so an unmirrored required step fails the gate. The run record's first field is now the short blob hash of `scripts/ci-local.js` instead of an `act` version. No Docker is required. |
| 2026-10-21 | 1.0.4 | PRD-2026-4dec59b8 was re-locked at v1.0.2 with runner-neutral wording (a wording-only change: the same 18 requirements, the same 47 acceptance criteria, the same priorities). Updated the PRD reference to v1.0.2 and replaced the "known mismatch" note, which is now false, with a resolution note. The six beads that quote the three reworded criteria (AC-004-5, AC-009-2, AC-015-2) were refreshed so they quote the current PRD text: TRD-003, TRD-003-TEST, TRD-005, TRD-005-TEST, TRD-012, TRD-012-TEST. No task, dependency, estimate or scenario changed. |
| 2026-10-21 | 1.0.5 | Implementation amendment (no requirement or AC change): the config gained optional `extra_steps`, `equivalents` and `excluded_steps` keys so a repository can declare how a workflow step that `ci:local` does not run is executed (AC-009-2) or recorded as excluded (AC-009-3). The TRD named the unmirrored-step failure but not where its resolution is declared; without it the gate failed on this repository with 5 unmirrored steps. Tracked as bead br-fhaa; delivered in 99fa619. |
| 2026-10-21 | 1.0.6 | Sequencing change by user decision (no requirement or AC change): removed `[Depends: TRD-001]` from TRD-004 so the App client can be built before the live proof; TRD-001 remains a required gate on the PR and on TRD-010's enablement step. Reverses the 1.0.1 decision that TRD-001 gates TRD-004. Reason: TRD-001 needs a GitHub App only the maintainer can create, and everything from TRD-005 on was blocked behind it. Cost accepted: TRD-004's behaviour against real GitHub is unproven until TRD-001 runs, and a failed proof could force rework of TRD-004 and TRD-003's 100-character bound. |
| 2026-10-21 | 1.0.7 | Pin updated to PRD 1.0.3, which records the measured baseline and the maintainer's decision that no numeric target is set for this repository (changelog only; no requirement or AC changed). TRD-011 is complete: the baseline is captured in `BASELINE.md` with reproducible raw rows, and the target decision is recorded in the PRD changelog. |
| 2026-10-21 | 1.0.8 | Sequencing change by user decision (no requirement or AC change): removed `[Depends: TRD-001]` from TRD-010 (added in 1.0.6) so the runbook and its snapshot/restore/refusal library can be built before the live proof. TRD-001 stays enforced two ways: TRD-010's runbook refuses enablement without `docs/proofs/local-ci-app-pin-proof.md` (the refusal AC and test scenario from 1.0.6 remain), and the proof gates opening the pull request. The runbook is built against injected GitHub responses and temp fixtures and is never run against a real repository in this change. |
| 2026-10-21 | 1.0.9 | Security redesign of TRD-012 after an independent adversarial review (no requirement or AC id changed; reverses the 1.0.3 choice to wrap `ci:local`). Reproduced against the real modules: the first design believed a `name PASS` table printed by the PR head's own `scripts/ci-local.js` (and `require()`d that file), so a head whose `npm run lint` and `npm run test` failed was approved; the approval set came from the working tree or the caller's payload, so with the PR branch checked out a PR that rewrote `.ensemble/local-ci.yaml` and its workflow to `true` was approved; a `bash -c` step passed when a middle command failed, which hosted CI fails; a workflow committed as a symlink was read from outside the clone; inherited environment secrets were not redacted. Now: the runner runs a trusted `steps` list from `.ensemble/local-ci.yaml` itself under `bash -e -o pipefail`, grades only exit statuses it observes, and never loads the head's `ci:local`; that file is read only with `git show <baseRef>:.ensemble/local-ci.yaml` (the PR's base branch, as `pull_request_target` does), `baseRef` is required, the head cannot be its own base, and the record carries the trusted config's blob hash; the payload cannot carry config, paths, scripts or runner options; a workflow resolving outside the clone is refused; steps get a minimal environment and credential-named values are redacted. `extra_steps` was replaced by `steps`. Consequence accepted: a PR that changes the gate is graded by the previous config and its change takes effect after merge. |
| 2026-10-21 | 1.0.10 | Hardening after a second adversarial review (no requirement or AC id changed). Reproduced and fixed: a base that is a descendant of (or equal to) the head is refused; `baseRef` must be a remote-tracking ref verified with `git show-ref`, so a local branch, SHA or reflog spelling cannot stand in for the PR's base; the run is voided if tracked file content, the index, HEAD or the clone's git config change during the steps (content comparison, since `assume-unchanged`/`skip-worktree` defeat git's own view; untracked output is allowed); the status record carries 12 hex of the config blob and `merge` requires it; optional `secret_names` (names only, base-ref config only) lets a step receive a configured secret, with configured values redacted. Residual trust recorded: the base branch name comes from GitHub's `baseRefName`, so a less-protected branch that a PR targets is graded by its own config. Delivered in ea0baeb. |
| 2026-10-21 | 1.0.11 | Hardening after a third adversarial review (no requirement or AC id changed; supersedes two statements in 1.0.10). Reproduced and fixed: `gate` and `merge` now require `repo` and `pr` and ask GitHub (`gh pr view`) for the PR's base branch, head commit and state BEFORE any config is read, refusing unless `baseRef` is exactly `origin/<that base>`, the PR is OPEN and `headSha` is its current head (1.0.10 said the base name came from GitHub's `baseRefName`; it actually came from the caller, so a contributor-pushed branch carrying a weaker config could be named as the base and approve a failing head); after every step the run is voided if a new untracked file lies outside the base config's `output_paths` (default `node_modules`, `coverage`, `.cache`, `dist`), superseding 1.0.10's statement that untracked output is allowed, because an untracked file is what a step can plant for a later command to read as permission to pass; steps run under a throwaway `HOME` (npm cache still the maintainer's) so they cannot rewrite `~/.gitconfig` or read `~/.ssh`; a tracked symlink resolving outside the clone, dangling links included, voids the run. Consequence accepted: the gate runs the head's own code and cannot stop a head's tests from asserting less; and `gate`/`merge` now need the maintainer's `gh` session at run time. |
| 2026-10-22 | 1.0.12 | **User decision: the maintainer-owned GitHub App is removed** (barrier to entry); the PRD moved to 1.0.4 (REQ-018 and AC-018-1/2/3 deleted, AC-004-4 reversed into an explicit honest-actor limit, AC-004-7 added). Trust is now honest-actor: the status is posted with the maintainer's own `gh` login, the required check `ensemble/local-ci` is unpinned (`app_id` null, written as `-1`), and any identity with write access can post a status that `pr-merge` accepts only if its run record verifies. **Deleted:** TRD-001 and TRD-001-TEST (App creation and app-pin proof) and TRD-004 and TRD-004-TEST (App client). **Added:** TRD-014 and TRD-014-TEST (gh-based status publisher, `local-ci-status.js`; `[Depends: TRD-003]`), new ids because TRD-004 is not reused with a different meaning. **Changed:** TRD-005 depends on TRD-014 instead of TRD-004 and gains the cannot-attest AC; TRD-003 gains the creator-not-consulted AC; TRD-009 gains the accept-by-record-only AC; TRD-010 enables protection with an unpinned check, requires a snapshot first and a first real success status before the check is required, and drops the App-pin-proof refusal AC and scenario; TRD-012 withholds `GH_TOKEN`/`GITHUB_TOKEN` from steps; TRD-002 no longer carries an App id. Removed the RS256 JWT dependency decision, the App-private-key security design, `local-ci-app.js` and the "one unproven fact" paragraph. Recomputed from the parser: 24 tasks (12 implementation, 12 test), 89h (PR 1 6h, PR 2 38h, PR 3 24h, PR 4 21h), longest chain TRD-003 -> TRD-014 -> TRD-005 -> TRD-009 -> TRD-010 -> TRD-010-TEST (depth 6), 30 declared edges. **Supersedes** the 1.0.1 statement that TRD-001 gates TRD-004 and heads the longest chain, the 1.0.6 and 1.0.8 sequencing decisions about TRD-001 (and 1.0.8's refusal AC and scenario for a missing App-pin proof), and the claim that AC-004-4 required the posting identity to be the App. |
| 2026-11-06 | 1.0.13 | Hosted-result reuse (PRD 1.0.5, new REQ-019; no existing requirement or AC changed, the 1.0.9 to 1.0.12 trust model is extended, not changed). **Why:** the 1.0.3 measurement put the hosted wait at a median 2.6 min (about 2.5% of open-to-merge, no target set), but on this repository the gate re-ran work hosted CI had already passed on the same head (`validate`, `test (22)`, `test (24)`, generated drift), an estimated 10 to 20 min of duplicate work under load; on PR #245 all 15 hosted checks were green and the merge was blocked until the local gate posted. Protection on `dev` was rolled back to the hosted required checks on 2026-11-06. **Added:** section "Hosted-result reuse" under System Architecture (design as built, trust claims, rejected options), TRD-015 and TRD-015-TEST (traceability: `packages/development/tests/local-ci-hosted*.test.js`), `hosted_reuse` config key, `forceLocal` payload key, `source:'hosted'`. Recomputed: 26 tasks (13 implementation, 13 test), 99h. No branch protection is changed by code or skills. |
