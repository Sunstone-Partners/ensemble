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
 *  - required job names are derived from the BASE ref's workflow file and config (`<id>` or `<id> (<matrix values>)`),
 *    never from anything the head supplies;
 *  - per (workflow file, event) the LATEST run for the head must be completed, on that head, from that workflow path,
 *    and a pull_request run must exist; every required job in it must be completed, on that head, with conclusion success.
 *
 * NOT VERIFIED: who triggered the run, that the workflow's steps are honest beyond file equality (the local gate shares
 * this: it also runs head code), and that a pull_request run's merge commit matched the base as it is now.
 */

const SHA_RE = /^[0-9a-fA-F]{40}$/;
const EVENTS = ['pull_request', 'push'];
const PER_PAGE = 100;

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
 * @param {{repo:string, headSha:string, baseSha:string, repoRoot:string, approvalSet:object}} input
 *   `repo` is owner/name already validated by the caller; baseSha is the resolved base commit.
 * @returns {{ok:true, source:'hosted', jobs:object[]} | {ok:false, reason:string, pending?:boolean, disabled?:boolean}}
 */
function verifyHosted({ repo, headSha, baseSha, repoRoot, approvalSet }, deps) {
  const refuse = (reason, extra) => ({ ok: false, source: 'hosted', reason: `hosted CI not accepted: ${reason}`, ...(extra || {}) });
  const reuse = approvalSet && approvalSet.hostedReuse;
  if (!reuse) return refuse('hosted_reuse is not enabled in the base-ref config', { disabled: true });
  if (typeof deps.ghApi !== 'function') return refuse('no GitHub lookup is available');
  if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) return refuse('head or base is not a full commit SHA');

  const groups = groupByWorkflow(reuse.checks);
  if (groups.size === 0) return refuse('the base config names no hosted jobs');

  // 1. Workflow files unchanged by the PR, and the exact job names GitHub will have given the jobs.
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
  if (Number.isInteger(runsAnswer.json.total_count) && runsAnswer.json.total_count > runs.length) {
    return refuse(`${runsAnswer.json.total_count} workflow runs exist for ${headSha}, more than the ${runs.length} read; refusing rather than guessing`);
  }

  const verified = [];
  for (const [file] of groups) {
    const forFile = runs.filter((r) => isObject(r) && r.path === file && same(r.head_sha, headSha) && EVENTS.includes(r.event));
    if (!forFile.some((r) => r.event === 'pull_request')) {
      return refuse(`no pull_request run of ${file} exists for ${headSha}`, { pending: true });
    }
    for (const event of EVENTS) {
      const candidates = forFile.filter((r) => r.event === event && Number.isInteger(r.id));
      if (candidates.length === 0) continue;
      const run = candidates.reduce((a, b) => (b.id > a.id ? b : a));
      if (run.status !== 'completed') return refuse(`the latest ${event} run of ${file} (${run.id}) is ${run.status}, not completed`, { pending: true });

      const jobsAnswer = deps.ghApi(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=${PER_PAGE}`);
      if (!jobsAnswer || jobsAnswer.ok !== true || !isObject(jobsAnswer.json) || !Array.isArray(jobsAnswer.json.jobs)) {
        return refuse(`cannot read the jobs of run ${run.id}: ${(jobsAnswer && jobsAnswer.error) || 'no answer'}`);
      }
      const jobs = jobsAnswer.json.jobs;
      if (Number.isInteger(jobsAnswer.json.total_count) && jobsAnswer.json.total_count > jobs.length) {
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
  return { ok: true, source: 'hosted', headSha, jobs: verified };
}

module.exports = { verifyHosted, expectedJobName };
