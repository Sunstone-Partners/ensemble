'use strict';

/**
 * Hosted-CI reuse for the local CI gate: decide whether the jobs hosted CI already ran on the PR's exact head
 * commit may stand in for a local clean-clone run. Pure over injected `deps` (git, ghApi); nothing is posted or run.
 *
 * WHAT IS ASKED OF GITHUB (never of the payload, the clone or the PR head):
 *   GET repos/<repo>/actions/runs?head_sha=<head>        workflow runs for that commit
 *   GET repos/<repo>/actions/runs/<id>/jobs              their jobs
 * Actions-service objects are used, NOT check runs or commit statuses: a status is postable by anyone with write access
 * and a workflow holding `checks: write` can post a check run under the GitHub Actions app, so a name (and app id)
 * match would let a head-supplied workflow forge a green `validate`.
 *
 * WHAT MUST HOLD (any failure is a refusal with a reason; the caller falls back to the local run):
 *  - the base-ref config opted in (`hosted_reuse`) and declares every local step as run by hosted CI (config validation);
 *  - each required workflow file has the SAME git blob at the PR head and at the base ref: hosted CI executes the head's
 *    workflow, so an edited workflow could make a job pass trivially. A PR touching it is graded locally instead;
 *  - no required job of a required base-ref workflow, nor any job it reaches through `needs:`, uses a repo-local action or
 *    reusable workflow (`uses: ./...`): the PR can change those files while the workflow file stays identical; none has
 *    `continue-on-error` other than literal false, or an `if:` reading github.head_ref/actor/triggering_actor/event
 *    (structural checks and a blacklist, not a proof: see structuralProblem);
 *  - required job names are derived from the BASE ref's workflow file and config (`<id>` or `<id> (<matrix values>)`),
 *    never from anything the head supplies;
 *  - only runs of THIS pull request count: a run is considered only when its `pull_requests[]` lists this PR's number
 *    with `base.ref` equal to the PR's base branch. A run of another PR that shares the head commit, a run for another
 *    base branch, and a run with no `pull_requests` (fork PRs, a closed PR) are IGNORED: they never count and never mask
 *    or replace this PR's run. (`base.sha` is not compared: the base branch moves constantly and equality would switch
 *    reuse off.) A fork PR therefore never gets hosted acceptance;
 *  - per (workflow file, event) the LATEST run for the head must be completed, on that head, from that workflow path,
 *    and a pull_request run must exist; every required job in it must be completed, on that head, with conclusion success;
 *  - shape surprises refuse: a run bound to this PR needs an integer id (it is refused, never dropped), and both listings
 *    need an integer `total_count` that is not more than what was read.
 *
 * NOT VERIFIED: who triggered the run, that the workflow's steps are honest beyond file equality (the local gate shares
 * this: it also runs head code), that a pull_request run's merge commit (head plus the base tip AT RUN TIME) matched the
 * base as it is now, and that an external action (`owner/repo@tag`) is what its tag was when the workflow was reviewed.
 */

const SHA_RE = /^[0-9a-fA-F]{40}$/;
const EVENTS = ['pull_request', 'push'];
const PER_PAGE = 100;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** GitHub's name for a job: its key, or `<key> (<matrix values in key order>)`; null when it cannot be derived safely. */
function expectedJobName(jobDef, id, matrix) {
  const keys = Object.keys(matrix || {});
  if (isObject(jobDef) && jobDef.name !== undefined) {
    // A custom name is only understood when it is a plain literal and no matrix decorates it.
    if (typeof jobDef.name !== 'string' || jobDef.name.includes('${{') || keys.length > 0) return null;
    return jobDef.name;
  }
  return keys.length === 0 ? id : `${id} (${keys.map((k) => String(matrix[k])).join(', ')})`;
}

/** Group the required checks by workflow file, preserving order. */
function groupByWorkflow(checks) {
  const groups = new Map();
  for (const c of checks) {
    if (!groups.has(c.workflow)) groups.set(c.workflow, []);
    groups.get(c.workflow).push(c);
  }
  return groups;
}

/** Blob of <sha>:<file>, or null. `sha` is a resolved commit, so a file name can never be read as an option. */
function blobAt(deps, cwd, sha, file) {
  const r = deps.git(['rev-parse', '--verify', '--end-of-options', `${sha}:${file}`], cwd);
  const out = r && r.status === 0 ? String(r.stdout).trim() : '';
  return SHA_RE.test(out) ? out.toLowerCase() : null;
}

function readJobs(deps, cwd, baseSha, file) {
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch (_e) {
    return { error: 'js-yaml is not resolvable, so the base workflow cannot be read' };
  }
  const shown = deps.git(['show', `${baseSha}:${file}`], cwd);
  if (!shown || shown.status !== 0) return { error: `cannot read ${file} at the base ref` };
  try {
    const doc = yaml.load(String(shown.stdout));
    return isObject(doc) && isObject(doc.jobs) ? { jobs: doc.jobs } : { error: `${file} at the base ref has no jobs` };
  } catch (err) {
    return { error: `${file} at the base ref is not valid YAML: ${err.message}` };
  }
}

/**
 * The first `uses:` of a job (its own, for a reusable workflow, or one of its steps) that names something in this
 * repository (`./.github/actions/x`, `./.github/workflows/y.yml`), as text; a `uses` that is not text cannot be judged and
 * is reported as such. Null when the job references only external actions. Those files are read from the PR's merge
 * commit by hosted CI, so equality of the workflow FILE says nothing about what they do.
 */
function repoLocalUse(jobDef) {
  if (!isObject(jobDef)) return null;
  const uses = [];
  if (jobDef.uses !== undefined) uses.push(jobDef.uses);
  if (Array.isArray(jobDef.steps)) for (const step of jobDef.steps) if (isObject(step) && step.uses !== undefined) uses.push(step.uses);
  for (const u of uses) {
    if (typeof u !== 'string') return `a non-text uses (${JSON.stringify(u)})`;
    if (u.trim().startsWith('.')) return u.trim();
  }
  return null;
}

/** `needs:` of a job as a list of job ids (a string or an array of strings; anything else names no job). */
function needsOf(jobDef) {
  if (!isObject(jobDef)) return [];
  if (typeof jobDef.needs === 'string') return [jobDef.needs];
  return Array.isArray(jobDef.needs) ? jobDef.needs.filter((n) => typeof n === 'string') : [];
}

/** A required job and everything it reaches through `needs:` in the same workflow file (transitive, cycle-safe), as an ordered list of ids. */
function needsClosure(jobs, id) {
  const seen = [id];
  for (let i = 0; i < seen.length; i++) {
    for (const n of needsOf(jobs[seen[i]])) if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

// PR-controlled GitHub contexts: an `if:` that reads one can skip a step although the workflow file is byte-identical.
const PR_CONTROLLED_IF = /github\.(head_ref|actor|triggering_actor|event)\b/;

/**
 * Static checks on a REQUIRED job and its `needs:` closure (all read from the base ref's workflow file), as a refusal
 * reason text or null. They look at structure and at a blacklist of PR-controlled contexts: they are NOT a proof that the
 * steps are honest, only that the commonest ways to make a green job say nothing are not present:
 *  - a repo-local `uses` anywhere in the closure (the PR can change what it runs while the workflow file stays identical);
 *  - `continue-on-error` (job or step) with any value but the literal `false`: the job can be green while a step failed;
 *  - an `if:` (job or step) naming head_ref, actor, triggering_actor or event: PR-controlled, it can skip a step.
 * An `if:` on matrix or env values is not PR-controlled and is allowed.
 */
function structuralProblem(jobs, id, file) {
  for (const jid of needsClosure(jobs, id)) {
    const def = jobs[jid];
    if (!isObject(def)) continue;
    const who = jid === id ? `job "${id}" in ${file}` : `job "${jid}" in ${file}, which required job "${id}" needs,`;
    const local = repoLocalUse(def);
    if (local !== null) {
      return `${who} uses a repo-local action or reusable workflow (${local}): a PR can change it while the workflow file stays identical, so it is graded by the local gate instead`;
    }
    const parts = [{ at: 'job', def }];
    if (Array.isArray(def.steps)) def.steps.forEach((st, i) => { if (isObject(st)) parts.push({ at: `step ${i + 1}`, def: st }); });
    for (const { at, def: part } of parts) {
      if (part['continue-on-error'] !== undefined && part['continue-on-error'] !== false) {
        return `${who} has continue-on-error (${JSON.stringify(part['continue-on-error'])}) at ${at}: the job can be green although a step failed, so it is graded by the local gate instead`;
      }
      if (part.if !== undefined && PR_CONTROLLED_IF.test(String(part.if))) {
        return `${who} has an if: condition at ${at} that reads a PR-controlled context (${JSON.stringify(String(part.if))}): it can skip work while the workflow file stays identical, so it is graded by the local gate instead`;
      }
    }
  }
  return null;
}

/**
 * @param {{repo:string, headSha:string, baseSha:string, repoRoot:string, approvalSet:object, pr:number, baseRefName:string}} input
 *   `repo` is owner/name already validated by the caller; baseSha is the resolved base commit; `pr` is the pull request
 *   number and `baseRefName` its base branch as GitHub reports them (the CLI checked both before this is reached).
 * @returns {{ok:true, source:'hosted', jobs:object[]} | {ok:false, reason:string, pending?:boolean, disabled?:boolean}}
 */
function verifyHosted({ repo, headSha, baseSha, repoRoot, approvalSet, pr, baseRefName }, deps) {
  const refuse = (reason, extra) => ({ ok: false, source: 'hosted', reason: `hosted CI not accepted: ${reason}`, ...(extra || {}) });
  const reuse = approvalSet && approvalSet.hostedReuse;
  if (!reuse) return refuse('hosted_reuse is not enabled in the base-ref config', { disabled: true });
  if (typeof deps.ghApi !== 'function') return refuse('no GitHub lookup is available');
  if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) return refuse('head or base is not a full commit SHA');
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return refuse('repo is not owner/name');
  if (!Number.isInteger(pr) || pr <= 0) return refuse('no pull request number to bind the runs to');
  if (typeof baseRefName !== 'string' || baseRefName === '') return refuse('no base branch name to bind the runs to');

  const groups = groupByWorkflow(reuse.checks);
  if (groups.size === 0) return refuse('the base config names no hosted jobs');

  // 1. Workflow files unchanged by the PR, no repo-local action behind them, and the exact job names GitHub gave the jobs.
  const expected = [];
  for (const [file, checks] of groups) {
    const baseBlob = blobAt(deps, repoRoot, baseSha, file);
    const headBlob = blobAt(deps, repoRoot, headSha, file);
    if (!baseBlob) return refuse(`${file} does not exist at the base ref`);
    if (!headBlob || headBlob !== baseBlob) {
      return refuse(`${file} at the PR head differs from the base ref (or is missing): hosted CI ran the head's workflow, so it is graded by the local gate instead`);
    }
    const read = readJobs(deps, repoRoot, baseSha, file);
    if (read.error) return refuse(read.error);
    for (const c of checks) {
      if (!isObject(read.jobs[c.job])) return refuse(`job "${c.job}" is not defined in ${file} at the base ref`);
      const structural = structuralProblem(read.jobs, c.job, file);
      if (structural !== null) return refuse(structural);
      const name = expectedJobName(read.jobs[c.job], c.job, c.matrix);
      if (name === null) return refuse(`cannot derive the hosted job name of "${c.job}" in ${file} (custom or computed name)`);
      expected.push({ workflow: file, name });
    }
  }

  // 2. Workflow runs for exactly this head.
  const runsAnswer = deps.ghApi(`repos/${repo}/actions/runs?head_sha=${headSha}&per_page=${PER_PAGE}`);
  if (!runsAnswer || runsAnswer.ok !== true || !isObject(runsAnswer.json) || !Array.isArray(runsAnswer.json.workflow_runs)) {
    return refuse(`cannot read workflow runs for ${headSha}: ${(runsAnswer && runsAnswer.error) || 'no answer'}`);
  }
  const runs = runsAnswer.json.workflow_runs;
  if (!Number.isInteger(runsAnswer.json.total_count)) {
    return refuse(`the workflow runs listing for ${headSha} carries no integer total_count, so it cannot be known to be complete; refusing rather than guessing`);
  }
  if (runsAnswer.json.total_count > runs.length) {
    return refuse(`${runsAnswer.json.total_count} workflow runs exist for ${headSha}, more than the ${runs.length} read; refusing rather than guessing`);
  }

  // A run counts for THIS pull request only: it lists the PR by number and base branch. Anything else is ignored, never
  // counted and never allowed to mask or replace this PR's own run.
  const belongsToThisPr = (r) =>
    Array.isArray(r.pull_requests) && r.pull_requests.some((p) => isObject(p) && p.number === pr && isObject(p.base) && p.base.ref === baseRefName);

  const verified = [];
  for (const [file] of groups) {
    const forFile = runs.filter((r) => isObject(r) && r.path === file && same(r.head_sha, headSha) && EVENTS.includes(r.event) && belongsToThisPr(r));
    // A run bound to this PR whose id is not an integer cannot be ordered against the others, so it could be a newer red
    // run that the latest-run choice below would silently skip: refuse, never drop it. Runs of other PRs stay ignored.
    const malformed = forFile.find((r) => !Number.isInteger(r.id));
    if (malformed) {
      return refuse(`a ${malformed.event} run of ${file} for ${headSha} that belongs to pull request #${pr} has a malformed id (${String(JSON.stringify(malformed.id))}), so the latest run cannot be chosen safely; refusing rather than ignoring it`);
    }
    const candidatesOf = (event) => forFile.filter((r) => r.event === event);
    if (candidatesOf('pull_request').length === 0) {
      return refuse(`no pull_request run of ${file} exists for ${headSha} that belongs to pull request #${pr} (base ${baseRefName})`, { pending: true });
    }
    for (const event of EVENTS) {
      const candidates = candidatesOf(event);
      if (candidates.length === 0) continue;
      const run = candidates.reduce((a, b) => (b.id > a.id ? b : a));
      if (run.status !== 'completed') return refuse(`the latest ${event} run of ${file} (${run.id}) is ${run.status}, not completed`, { pending: true });

      const jobsAnswer = deps.ghApi(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=${PER_PAGE}`);
      if (!jobsAnswer || jobsAnswer.ok !== true || !isObject(jobsAnswer.json) || !Array.isArray(jobsAnswer.json.jobs)) {
        return refuse(`cannot read the jobs of run ${run.id}: ${(jobsAnswer && jobsAnswer.error) || 'no answer'}`);
      }
      const jobs = jobsAnswer.json.jobs;
      if (!Number.isInteger(jobsAnswer.json.total_count)) {
        return refuse(`the jobs listing of run ${run.id} carries no integer total_count, so it cannot be known to be complete; refusing rather than guessing`);
      }
      if (jobsAnswer.json.total_count > jobs.length) {
        return refuse(`run ${run.id} has ${jobsAnswer.json.total_count} jobs, more than the ${jobs.length} read; refusing rather than guessing`);
      }
      for (const want of expected.filter((e) => e.workflow === file)) {
        const job = jobs.find((j) => isObject(j) && j.name === want.name);
        if (!job) return refuse(`required job "${want.name}" is missing from the latest ${event} run of ${file} (${run.id})`);
        if (job.status !== 'completed') return refuse(`job "${want.name}" of run ${run.id} is ${job.status}, not completed`, { pending: true });
        if (!same(job.head_sha, headSha) || (job.run_id !== undefined && job.run_id !== run.id)) {
          return refuse(`job "${want.name}" of run ${run.id} is not on head ${headSha}`);
        }
        if (job.conclusion !== 'success') return refuse(`job "${want.name}" of run ${run.id} concluded ${job.conclusion}, not success`);
        verified.push({ workflow: file, event, runId: run.id, jobId: job.id, name: want.name, conclusion: job.conclusion });
      }
    }
  }

  // Unreachable by construction: a missing pull_request run refuses above, and every required job is checked in every run
  // that is used. Kept as an assertion so a future edit that breaks the invariant is a loud programming error (an Error,
  // never a user-facing refusal and never a silent accept).
  const inPullRequestRuns = verified.filter((v) => v.event === 'pull_request');
  if (verified.length === 0 || inPullRequestRuns.length !== expected.length) {
    throw new Error(`verifyHosted: internal error: ${inPullRequestRuns.length} of the ${expected.length} required jobs were verified in pull_request runs`);
  }
  return { ok: true, source: 'hosted', headSha, jobs: verified };
}

module.exports = { verifyHosted, expectedJobName, repoLocalUse };
