'use strict';

/**
 * pr-review-run.js -- the light-mode review runner (kata znd1, epic ptqb, plan section 3G). LOGIC ONLY.
 *
 * A script cannot dispatch model agents. It CAN do every mechanical step of a light review and hand the model exactly
 * two jobs: start the agents a manifest names, and call `collect` again. This module is those steps, over injected
 * `deps`; it has no file system, process or network access of its own. `review-run-cli.js` supplies the real deps
 * (review-precheck-cli's `makeDeps` for `gh`/`git` reads, `prepareReview`, the result files, `writeState`, the tracer).
 *
 *   prepareRun(input, deps)   precheck -> prepare -> tier -> mode -> depth -> slices -> briefs -> DISPATCH (round review)
 *   collectRun(input, deps)   head check -> collect the outstanding wave -> (next wave | verify round | finalise)
 *
 * Statuses (stdout of the CLI; exit 0 when ok):
 *   ok:true   DISPATCH | PENDING | TRIAGE | DONE | ADJUDICATE       (TRIAGE: full mode only)
 *   ok:false  NEEDS_FULL_MODE | RUN_INVALIDATED | RUN_FAILED
 *
 * What this module never does -- each is a guard with a test:
 *   - The review's overall status is never computed here: `reviewStatus` is `deriveStatus` over real facts, nothing else,
 *     and the runner never supplies the remote phase, so it can never report a finished review by itself.
 *   - It never edits the reviewed tree and never pushes: its only git calls are `merge-base` and `rev-parse`, its only
 *     gh write is the precheck's one PR comment, everything it writes lives under `.ensemble/pr-review/`.
 *   - It never sets a ledger `resolution`, `cleared`, `blocking:false` or a waiver; an agent that writes one has it
 *     stripped. An adjudication (`fix` | `deferred` | `not-applicable`) is applied only to findings listed for adjudication
 *     and can never close an Important or security finding beyond what `isActionable` and the gate allow.
 *   - A head that moved is never reviewed on: RUN_INVALIDATED, nothing written to the ledger, the gate or the state report.
 *     That holds for a FINISHED run too: its stored answer is returned only while the live head is the reviewed one on an
 *     OPEN PR (collect re-reads the PR first), and a PR that is not OPEN gets no run and no verdict at all.
 *   - A head from outside this repository (a fork, or a repository GitHub did not state) is refused by name before anything
 *     is fetched, prepared, run or posted; a baseSha other than the merge base is refused (RUN_FAILED, no run).
 *   - A reviewer's `pre-existing` severity is a claim, borne out only by the diff and the head: on a changed line, on a path
 *     that names no regular file of the head (a mis-spelled, mis-cased or invented path, a symlink) or on a line past the end of
 *     that file, it is graded Important.
 *   - An agent that did not arrive is never read as reviewed: its slice is in `notReviewed`, a verifier's candidates are
 *     `unverified`, a missing security lane is not `clean`.
 *   - An unreadable, ambiguous, raised, High or sensitive tier selects FULL mode, which runs in this same runner (Deep depth,
 *     the security lane, a model-orchestrator TRIAGE stop, the re-review scope rule: pr-review-full.js). The mode comes from
 *     `selectMode` alone and is stored in the run. Every later call only CHECKS that label against `selectMode` over the tier
 *     the run stores (`modeInvariant`): a label rewritten to light, removed or unknown is RUN_FAILED `mode-invariant`, never a
 *     new mode, so nothing here can lower a full run to light.
 *     NEEDS_FULL_MODE is left for a LIGHT run whose brief the renderer refuses (nothing dispatched; the narrated procedure).
 *
 * HONEST LIMITS: the runner computes and records agent deadlines and the concurrency cap, and cannot enforce either;
 * whoever dispatches must stop an agent at `deadlineAtIso` and keep to `maxConcurrentAgents`. The tier comes from the
 * changed paths alone (no classifier or second assessor), so a path-only reading can raise a tier but never lower one.
 * Coverage is the agents' own report (`pathsReviewed`) and their read-only access an instruction nobody here enforces. The
 * baseline test run (head code) happens inside prepare, before the tier is known. `agentAuthored` is the caller's word.
 * `run.json` is local, unauthenticated state: `modeInvariant` refuses a stored run whose mode label is not `selectMode`'s answer
 * for the tier it stores, and a FULL run whose depth, verifier count or lane was lowered. It cannot tell a run whose tier,
 * label, depth and lane were all rewritten together from an honest light run, so whoever can write the run directory can
 * still choose the mode of a run that has not finished by rewriting all of them. The mode of a NEW run is only ever
 * `selectMode`'s.
 *
 * deps (every function may be async):
 *   now()                                    epoch ms
 *   makeTracer(traceRunId)                   -> {startSpan(name,{kind,attrs}), endSpan(id,{status,attrs})}   (never throws)
 *   readPr()                                 -> {ok, headSha, baseRefName, state, body, author, isCrossRepository}
 *   readReviews() / readProtection(base)     -> {ok, reviews} / {ok, notProtected?, protection?}
 *   git(args)                                -> {status, stdout, stderr}          (argv array, run in the repository)
 *   fetchRefs({headSha, baseRefName})        -> {ok} | {ok:false, error}          (fetch base and head)
 *   precheck({dryRun})                       -> a runPrecheck result
 *   prepareReview(options)                   -> a prepareReview result
 *   collectResults(input)                    -> a collectResults result            (real fs lives in the CLI)
 *   renderBrief(role, vars)                  -> markdown; THROWS when the renderer refuses an input
 *   writeState(path, state)                  -> {ok, path|reason}
 *   fs.{mkdirp(dir,mode), writeAtomic(file,text,mode), readText(file) -> string|null}
 *   fs.headFile(root, rel)                   -> {lines}|null     the regular file `rel` names in the head snapshot `root`, exactly spelled, never followed
 *   redact(value)                            optional deep redaction applied to everything written or returned
 */

const path = require('path');

const { isValidRunId } = require('./toolchain/run-id');
const { assignTier, effectiveTier, tierRecord } = require('./pr-review-tier');
const { selectMode } = require('./pr-review-mode');
const { planSlices, verifyCoverage } = require('./pr-review-depth');
const { reviewDeadlines, toVotesInput } = require('./pr-review-results');
const { dedupeFindings, isActionable, normalizeSeverity, validateLedger } = require('./pr-review-ledger');
const { tallyVotes } = require('./pr-review-votes');
const { evaluateApprovals } = require('./pr-review-approvals');
const { checkDescription } = require('./pr-review-description');
const { evaluateGate, SECURITY_REQUIRED_TIERS } = require('./pr-review-gate');
const { buildDispositionChoices } = require('./pr-review-disposition');
const { deriveStatus } = require('./pr-review-status');
const { statePath } = require('./pr-review-state');
const { assessProtection } = require('./pr-review-precheck');
const S = require('./pr-review-run-support');
const F = require('./pr-review-full');

const SCHEMA = 1;
const RUN_SUBDIR = path.join('.ensemble', 'pr-review', 'run');
const LANE_NAME = 'security-lane';
const LANE_COVERAGE_SLICE = 'security-lane-coverage';
const DEFAULT_MAX_CONCURRENT = 8;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ADJUDICATION_DISPOSITIONS = Object.freeze(['fix', 'deferred', 'not-applicable']);

const PREPARE_KEYS = Object.freeze(['repo', 'pr', 'repoRoot', 'runId', 'traceRunId', 'baseSha', 'lastReviewedSha', 'remediationShas', 'dryRun', 'skipPrecheck', 'testFiles', 'testCommand', 'baselineTimeoutMs', 'nodeModules', 'stateRoot', 'agentAuthored']);
const COLLECT_KEYS = Object.freeze(['repoRoot', 'runId', 'now', 'adjudications', 'triage']);

const RULES = Object.freeze([
  'Start exactly the agents of `agents`, in fresh contexts with READ-ONLY access, and pass each `prompt` through unedited; compose nothing yourself.',
  'Never run more agents at once than `maxConcurrentAgents`. The runner records the cap and cannot enforce it: the dispatcher must.',
  'Stop every agent at its `deadlineAtIso`. The runner records the deadline and cannot stop an agent: the dispatcher must. A result written later is not read.',
  'When the agents are done (or their deadlines have passed), call `collect`. Never read a result file, tally votes or decide a gate yourself.',
  'On ADJUDICATE decide only the findings listed, with a reason, and call `collect` with `adjudications`.',
  'Coverage is self-reported: the runner counts a slice as reviewed when the agent lists its paths in `pathsReviewed`, and cannot tell a read from a claim. Read-only access is an instruction in the prompt that the runner cannot enforce: the dispatcher must.',
]);

/** What a TRIAGE answer tells the orchestrating model, on top of RULES. */
const TRIAGE_RULES = Object.freeze([
  'This is a FULL-mode run: nothing is dispatched on this answer. Read the candidates, the coverage and the security lane, then call `collect` again with `triage`.',
  'Triage can only ADD candidates the reviewers missed (for example an interaction between slices): `{"triage":{"additionalCandidates":[{"locationOrLink":"path/file.js:12","failureMode":"what goes wrong","severity":"important|nit","evidence":"what you read"}]}}`. `{"triage":{}}` adds none. A location must be a line of a regular file of the head, named by a repository-relative path; an entry that matches a candidate the reviewers already raised is dropped and theirs stays as it was.',
  'Every candidate, yours included, is then settled by independent fresh-context verifiers who are briefed with the claim and its location only. You can not remove, merge away, re-grade, close or waive a candidate, mark a slice reviewed, or decide a verdict: the gate and whether the review is complete are computed by the runner alone.',
  'A `collect` without `triage` repeats this answer; the run cannot reach verification without it.',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const msg = (error) => (error && error.message ? error.message : String(error));

/* ------------------------------------------------------------------ plumbing */

const failure = (status, fields) => ({ ok: false, status, ...fields });
const redactor = (deps) => (typeof deps.redact === 'function' ? deps.redact : (value) => value);

/** A PR the host does not state as exactly OPEN gets no review and no verdict. */
const notOpen = (state, runId, headSha) => failure('RUN_FAILED', { reason: 'pr-not-open', error: `the pull request is ${JSON.stringify(state)}, not OPEN`, prState: state, ...(runId === undefined ? {} : { runId }), ...(headSha === undefined ? {} : { headSha }) });

const runDirOf = (repoRoot, runId) => path.join(repoRoot, RUN_SUBDIR, runId);

function noopTracer() {
  return { startSpan: () => null, endSpan: () => false };
}

/** A tracer that can never throw, whatever the injected one does. */
function safeTracer(deps, traceRunId) {
  let tracer;
  try {
    tracer = typeof deps.makeTracer === 'function' ? deps.makeTracer(traceRunId) : noopTracer();
  } catch (_error) {
    tracer = noopTracer();
  }
  return {
    start(name, kind, attrs) {
      try {
        return tracer.startSpan(name, { kind, attrs });
      } catch (_error) {
        return null;
      }
    },
    end(spanId, status, attrs) {
      if (spanId === null || spanId === undefined) return;
      try {
        tracer.endSpan(spanId, { status, attrs });
      } catch (_error) {
        // tracing never fails the run
      }
    },
  };
}

async function settle(fn) {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, error: msg(error) };
  }
}

/** The PR's head as the host states it now: a full sha, or the reason it could not be read. */
async function readHead(deps) {
  const pr = await settle(() => deps.readPr());
  if (!isObject(pr) || pr.ok !== true) return { ok: false, error: isObject(pr) && isText(pr.error) ? pr.error : 'the pull request could not be read' };
  const headSha = typeof pr.headSha === 'string' ? pr.headSha.toLowerCase() : '';
  if (!SHA.test(headSha)) return { ok: false, error: 'the pull request reports no usable head commit' };
  return { ok: true, headSha, pr };
}

function saveRun(deps, run) {
  const dir = runDirOf(run.repoRoot, run.runId);
  deps.fs.mkdirp(dir, 0o700);
  deps.fs.writeAtomic(path.join(dir, 'run.json'), `${JSON.stringify(redactor(deps)(run), null, 2)}\n`, 0o600);
}

function loadRun(deps, repoRoot, runId) {
  const text = deps.fs.readText(path.join(runDirOf(repoRoot, runId), 'run.json'));
  if (text === null) return null;
  try {
    const run = JSON.parse(text);
    return isObject(run) && run.schema === SCHEMA && run.runId === runId ? run : undefined;
  } catch (_error) {
    return undefined;
  }
}

/** The hunks of the prepared range diff, or null when it cannot be read (a claim that needs it is then not borne out). */
function readDiffIndex(deps, file) {
  try {
    const text = typeof file === 'string' ? deps.fs.readText(file) : null;
    return text === null ? null : S.parseDiffHunks(text);
  } catch (_error) {
    return null;
  }
}

function logCall(run, call, startedAt, deps, adjudication = false, flags = {}) {
  run.calls = Array.isArray(run.calls) ? run.calls : [];
  run.calls.push({ call, startedAt, endedAt: deps.now(), ...(adjudication ? { adjudication: true } : {}), ...flags });
}

/** Records a terminal phase with its answer, so every later call repeats it. */
function terminate(run, phase, answer, call, startedAt, deps) {
  run.phase = phase;
  run.result = answer;
  logCall(run, call, startedAt, deps);
  saveRun(deps, run);
  return answer;
}

/* ------------------------------------------------------------------- prepare */

function validatePrepare(input) {
  if (!isObject(input)) return 'the payload must be a JSON object';
  for (const key of Object.keys(input)) if (!PREPARE_KEYS.includes(key)) return `unknown payload key ${JSON.stringify(key)}`;
  if (!isText(input.repo) || !REPO.test(input.repo)) return 'repo must be "owner/name"';
  if (!Number.isInteger(input.pr) || input.pr < 1) return 'pr must be a positive integer';
  if (!isText(input.repoRoot) || !path.isAbsolute(input.repoRoot)) return 'repoRoot must be an absolute path';
  for (const key of ['runId', 'traceRunId', 'nodeModules', 'stateRoot']) if (input[key] !== undefined && !isText(input[key])) return `${key} must be a non-empty string`;
  for (const key of ['baseSha', 'lastReviewedSha']) if (input[key] !== undefined && !SHA.test(String(input[key]))) return `${key} must be a full 40-hex object id`;
  if (input.remediationShas !== undefined && !(Array.isArray(input.remediationShas) && input.remediationShas.every((s) => SHA.test(String(s))))) return 'remediationShas must be full object ids';
  for (const key of ['dryRun', 'skipPrecheck', 'agentAuthored']) if (input[key] !== undefined && typeof input[key] !== 'boolean') return `${key} must be true or false`;
  if (input.testFiles !== undefined && !(Array.isArray(input.testFiles) && input.testFiles.every(isText))) return 'testFiles must be an array of paths';
  if (input.testCommand !== undefined && !(Array.isArray(input.testCommand) && input.testCommand.length > 0 && input.testCommand.every(isText))) return 'testCommand must be a non-empty argv array';
  if (input.baselineTimeoutMs !== undefined && !(Number.isInteger(input.baselineTimeoutMs) && input.baselineTimeoutMs > 0)) return 'baselineTimeoutMs must be a positive integer';
  return null;
}

function summarisePrecheck(result) {
  if (!isObject(result)) return { ok: false, error: 'the precheck returned nothing' };
  const comment = isObject(result.comment) ? { action: result.comment.action, id: result.comment.id, url: result.comment.url, error: result.comment.error } : undefined;
  return {
    ok: result.ok === true,
    error: result.error,
    stage: result.stage,
    blockers: result.blockers,
    notEstablished: result.notEstablished,
    approvals: result.approvals,
    description: result.description,
    protection: result.protection,
    gate: result.gate,
    comment,
  };
}

/** Builds the review round's agents and writes their brief files. Throws the renderer's refusal. */
function buildReviewAgents(run, deps, ctx) {
  const dir = runDirOf(run.repoRoot, run.runId);
  const agents = [];
  const minutes = (role) => reviewDeadlines({ role, now: ctx.now, tier: run.tier.effectiveTier, depth: run.depth.mode, policy: run.policy }).minutes;
  run.slices.forEach((slice, sliceIndex) => {
    // one reviewer per (slice, lens) pass; the lenses come from the shared plan (planSlices), the names stay `reviewer-s<n>-<a|b|..>`
    run.assignments.filter((assignment) => assignment.sliceId === slice.id).forEach((assignment, lensIndex) => {
      const name = `reviewer-s${sliceIndex + 1}-${S.LENSES[lensIndex]}`;
      agents.push({ name, role: 'reviewer', sliceId: slice.id, lens: assignment.lens, paths: slice.paths, _vars: { slice: slice.id, lens: assignment.lens, timeboxMinutes: minutes('reviewer'), paths: slice.paths, diffPath: run.prepared.rangeDiff, snapshotDir: run.prepared.snapshotDir }, _role: 'reviewer' });
    });
  });
  if (run.securityLane) {
    agents.push({ name: LANE_NAME, role: 'security', sliceId: LANE_COVERAGE_SLICE, lens: 'security', paths: run.changedPaths, _role: 'security-lane', _vars: { range: `${run.baseSha}..${run.headSha}`, diffPath: run.prepared.rangeDiff, snapshotDir: run.prepared.snapshotDir, sensitivePaths: run.sensitivePaths } });
  }
  return agents.map((agent) => {
    const briefPath = path.join(dir, 'briefs', `${agent.name}.md`);
    const outPath = path.join(dir, 'results', 'review', `out-${agent.name}.json`);
    const { _vars, _role, ...record } = agent;
    const rendered = deps.renderBrief(_role, _vars);
    const full = { ...record, briefPath, outPath };
    deps.fs.mkdirp(path.dirname(briefPath), 0o700);
    deps.fs.writeAtomic(briefPath, `${rendered.replace(/\s*$/, '\n')}\n${S.reviewerContract(full)}`, 0o600);
    return full;
  });
}

/** Stamps a wave's agents with their dispatch time and deadline, opens their spans and makes their result directory. */
function dispatchWave(run, wave, now, deps, tracer) {
  const dispatched = [];
  const resultDir = path.join(runDirOf(run.repoRoot, run.runId), 'results', wave.round);
  deps.fs.mkdirp(resultDir, 0o700);
  for (const agent of wave.agents) {
    const deadline = reviewDeadlines({ role: agent.role, now, tier: run.tier.effectiveTier, depth: run.depth.mode, policy: run.policy });
    if (deadline.ok !== true) throw new Error(`no deadline for ${agent.name}: ${deadline.reason}`);
    agent.dispatchedAt = deadline.dispatchedAt;
    agent.deadlineAt = deadline.deadlineAt;
    agent.deadlineAtIso = deadline.deadlineAtIso;
    agent.prompt = S.agentPrompt(agent);
    agent.spanId = tracer.start(`agent:${agent.name}`, 'agent', { role: agent.role, round: wave.round, wave: wave.wave });
    dispatched.push(agent);
  }
  wave.status = 'dispatched';
  wave.dispatchedAt = now;
  return dispatched;
}

function manifestOf(run, wave) {
  return {
    ok: true,
    status: 'DISPATCH',
    runId: run.runId,
    round: wave.round,
    wave: `${wave.wave} of ${wave.of}`,
    headSha: run.headSha,
    mode: run.mode,
    ...(run.reReview === undefined ? {} : { reReview: run.reReview }),
    tier: run.tier,
    depth: { mode: run.depth.mode, reviewersPerSlice: run.depth.reviewersPerSlice, verifiersPerCandidate: run.depth.verifiersPerCandidate, bounds: run.depth.bounds },
    maxConcurrentAgents: run.maxConcurrentAgents,
    agents: wave.agents.map((a) => ({
      name: a.name,
      role: a.role,
      briefPath: a.briefPath,
      outPath: a.outPath,
      prompt: a.prompt,
      dispatchedAt: a.dispatchedAt,
      deadlineAt: a.deadlineAt,
      deadlineAtIso: a.deadlineAtIso,
      ...(a.sliceId !== undefined && a.role === 'reviewer' ? { sliceId: a.sliceId, paths: a.paths } : {}),
      ...(a.candidateIds !== undefined ? { candidateIds: a.candidateIds } : {}),
    })),
    next: `node review-run-cli.js collect  (payload {"repoRoot": ${JSON.stringify(run.repoRoot)}, "runId": ${JSON.stringify(run.runId)}})`,
    rules: run.mode && run.mode.mode === 'full' ? [...RULES, 'Full mode: when the review round is collected the runner answers TRIAGE, not a verify wave; follow its rules.'] : RULES,
  };
}

async function prepareRun(input, deps) {
  const startedAt = deps.now();
  const invalid = validatePrepare(input);
  if (invalid !== null) return failure('RUN_FAILED', { reason: 'invalid-input', error: invalid });

  const first = await readHead(deps);
  if (!first.ok) return failure('RUN_FAILED', { reason: 'pr-unreadable', error: first.error });
  const { headSha } = first;
  const baseRefName = first.pr.baseRefName;

  // The baseline runs the head's own test code on this machine and the reviewers read (and may run) the head's snapshot,
  // so a head from outside this repository is not reviewed here: the precheck refuses a fork for its gate the same way.
  // A head whose repository GitHub did not state is not "this repository" either. Refused by name, before anything is
  // fetched, prepared, posted or written.
  if (first.pr.isCrossRepository !== false) {
    const fork = first.pr.isCrossRepository === true;
    return failure('RUN_FAILED', {
      reason: fork ? 'cross-repository-head' : 'head-repository-unknown',
      error: fork
        ? 'the head of this pull request is on a fork, and the runner would run the head\'s own test code on this machine and hand its snapshot to agents, so it does not review a head from outside this repository; read the diff by hand'
        : 'GitHub did not say whether the head of this pull request is on this repository, and the runner runs the head\'s own test code on this machine, so it does not review it',
      headSha,
    });
  }

  // Only an open PR is reviewed: a merged or closed one gets no agents and no answer that could read as mergeable (the
  // precheck refuses it too, but its refusal is advisory here).
  if (first.pr.state !== 'OPEN') return notOpen(first.pr.state, undefined, headSha);

  const runId = input.runId !== undefined ? input.runId : `pr${input.pr}-${headSha.slice(0, 12)}-${Math.floor(startedAt / 1000)}`;
  if (!isValidRunId(runId)) return failure('RUN_FAILED', { reason: 'invalid-runId', error: `runId ${JSON.stringify(runId)} is not file-name safe (letters, digits, "_", "-"; no dots)` });
  const traceRunId = input.traceRunId !== undefined ? input.traceRunId : runId;
  if (deps.fs.readText(path.join(runDirOf(input.repoRoot, runId), 'run.json')) !== null) {
    return failure('RUN_FAILED', { reason: 'run-exists', error: `run ${runId} already exists; call collect, or choose another runId` });
  }
  const tracer = safeTracer(deps, traceRunId);

  // 2. precheck (advisory: a failed precheck never stops the review)
  let precheck;
  if (input.skipPrecheck === true) {
    precheck = { skipped: true, reason: 'requested' };
  } else {
    const span = tracer.start('precheck', 'io', { pr: input.pr });
    precheck = summarisePrecheck(await settle(() => deps.precheck({ dryRun: input.dryRun === true })));
    tracer.end(span, precheck.ok ? 'ok' : 'error', { ok: precheck.ok });
  }

  // base: always the merge base of the freshly fetched base branch and the head. A caller-stated baseSha is checked
  // against it, never trusted: a commit inside the PR would narrow the changed paths, tier, slices and coverage to the
  // suffix, and the gate would grade only that suffix with no sign that the earlier commits went unreviewed.
  const refs = await settle(() => deps.fetchRefs({ headSha, baseRefName }));
  if (!isObject(refs) || refs.ok !== true) return failure('RUN_FAILED', { reason: 'refs-unavailable', error: isObject(refs) && refs.error ? refs.error : 'the base and head could not be fetched', precheck });
  const mb = await settle(() => deps.git(['merge-base', `refs/remotes/origin/${baseRefName}`, headSha]));
  const baseSha = isObject(mb) && mb.status === 0 ? String(mb.stdout).trim().toLowerCase() : '';
  if (!SHA.test(baseSha)) return failure('RUN_FAILED', { reason: 'base-unresolved', error: `no merge base of origin/${baseRefName} and ${headSha}`, precheck });
  if (input.baseSha !== undefined && input.baseSha !== baseSha) {
    return failure('RUN_FAILED', { reason: 'base-not-merge-base', error: `baseSha ${input.baseSha} is not the merge base of origin/${baseRefName} and ${headSha} (${baseSha}); any other base reviews a different range than this pull request's own changes (a later one leaves earlier commits unreviewed and unreported), so the runner takes the merge base itself and accepts a stated baseSha only when it is that commit`, precheck });
  }

  // 3. prepare (snapshot, diffs, facts, baseline)
  const prepSpan = tracer.start('prepare-head', 'phase', { headSha });
  const options = { repoRoot: input.repoRoot, runId, baseSha, headSha };
  for (const key of ['lastReviewedSha', 'remediationShas', 'stateRoot', 'testFiles', 'testCommand', 'baselineTimeoutMs', 'nodeModules']) if (input[key] !== undefined) options[key] = input[key];
  const prepared = await settle(() => deps.prepareReview(options));
  tracer.end(prepSpan, isObject(prepared) && prepared.ok === true ? 'ok' : 'error', {});
  if (!isObject(prepared) || prepared.ok !== true) {
    return failure('RUN_FAILED', { reason: 'prepare-failed', error: isObject(prepared) ? `${prepared.reason || 'unknown'}: ${prepared.detail || ''}`.trim() : 'prepare returned nothing', stage: isObject(prepared) ? prepared.stage : undefined, precheck });
  }
  const artifact = (name) => (isObject(prepared.artifacts) && isObject(prepared.artifacts[name]) ? prepared.artifacts[name].path : null);
  const readArtifact = (name) => {
    const file = artifact(name);
    const text = file === null ? null : deps.fs.readText(file);
    try {
      return text === null ? null : JSON.parse(text);
    } catch (_error) {
      return null;
    }
  };
  const facts = readArtifact('facts.json');
  const baselineRecord = readArtifact('baseline.json');
  if (!isObject(facts) || !Array.isArray(facts.changedPaths) || !Array.isArray(facts.numstat) || artifact('range.diff') === null || artifact('snapshot') === null) {
    return failure('RUN_FAILED', { reason: 'facts-unreadable', error: 'facts.json, range.diff or the snapshot of the prepared directory could not be read', precheck });
  }
  if (prepared.headSha !== headSha || prepared.baseSha !== baseSha) {
    return failure('RUN_FAILED', { reason: 'prepared-other-range', error: 'the prepared directory is not for this base and head', precheck });
  }

  const run = {
    schema: SCHEMA,
    runId,
    traceRunId,
    repo: input.repo,
    pr: input.pr,
    repoRoot: input.repoRoot,
    headSha,
    baseSha,
    baseRefName,
    author: first.pr.author,
    prState: first.pr.state,
    agentAuthored: input.agentAuthored,
    dryRun: input.dryRun === true,
    lastReviewedSha: input.lastReviewedSha,
    remediationShas: input.remediationShas,
    precheck,
    prepared: {
      dir: prepared.dir,
      reused: prepared.reused === true,
      manifestPath: prepared.manifestPath,
      rangeDiff: artifact('range.diff'),
      deltaDiff: artifact('delta.diff') || undefined,
      snapshotDir: artifact('snapshot'),
      factsPath: artifact('facts.json'),
      mode: prepared.mode,
      absent: prepared.absent,
    },
    baseline: isObject(baselineRecord) ? { ran: baselineRecord.ran === true, exitCode: baselineRecord.exitCode, timedOut: baselineRecord.timedOut === true, reason: baselineRecord.reason || null, command: baselineRecord.command, files: Array.isArray(baselineRecord.selection) ? baselineRecord.selection.map((s) => s.file) : [] } : null,
    changedPaths: facts.changedPaths,
    numstat: facts.numstat,
    policy: isObject(facts.policy) && isObject(facts.policy.policy) ? facts.policy.policy : null,
    sensitivePaths: isObject(facts.paths) && Array.isArray(facts.paths.sensitive) ? facts.paths.sensitive : [],
    phase: 'preparing',
    waves: [],
    calls: [],
    createdAt: startedAt,
  };

  // the head must not have moved while the preparation ran
  const second = await readHead(deps);
  if (!second.ok) return failure('RUN_FAILED', { reason: 'head-unreadable', error: second.error, precheck });
  if (second.headSha !== headSha) {
    return terminate(run, 'invalidated', failure('RUN_INVALIDATED', { reason: 'head-moved', runId, expectedHead: headSha, currentHead: second.headSha, precheck }), 'prepare', startedAt, deps);
  }
  if (second.pr.state !== 'OPEN') return notOpen(second.pr.state, runId, headSha);

  // 5-6. tier from the paths alone, then the mode
  const assignment = assignTier({ paths: facts.paths, kinds: S.deriveKinds(facts.changedPaths) });
  const effective = effectiveTier({ assignment, policy: run.policy === null ? undefined : run.policy, author: run.author });
  const record = tierRecord({ assignment, effective, assignedBy: 'review-run (changed paths only)', at: new Date(startedAt).toISOString() });
  const tier = { ...record, ok: record.ok === true && assignment.ok === true && effective.ok === true };
  const mode = selectMode(tier);
  run.tier = tier;
  run.mode = mode;
  const isFull = mode.mode === 'full';
  if (isFull) {
    run.reReview = F.planReReview({ lastReviewedSha: input.lastReviewedSha, rangeMode: prepared.mode, deltaPlan: facts.deltaPlan, delta: facts.delta, paths: facts.paths });
  }

  // 7-8. depth and slices
  // Full mode is always Deep, whatever the tier word says (an unreadable tier resolves no depth of its own).
  const planned = S.planDepth(isFull ? { tier: F.FULL_DEPTH_TIER, effectiveTier: F.FULL_DEPTH_TIER } : tier);
  if (planned.ok !== true) return failure('RUN_FAILED', { reason: 'depth-refused', error: planned.reason, precheck });
  run.depth = planned.depth;
  const sliced = planSlices({ paths: facts.numstat.map((f) => ({ path: f.path, lines: (f.added || 0) + (f.deleted || 0) })), threshold: run.policy && Number.isInteger(run.policy.sliceThreshold) ? run.policy.sliceThreshold : undefined, mode: run.depth.mode, lensesPerSlice: run.depth.reviewersPerSlice });
  if (sliced.ok !== true) return failure('RUN_FAILED', { reason: 'slices-refused', error: sliced.reason, precheck });
  run.slices = sliced.slices;
  run.assignments = sliced.reviewerAssignments;
  run.sliced = sliced.sliced;
  run.securityLane = isFull || SECURITY_REQUIRED_TIERS.includes(tier.tier) || SECURITY_REQUIRED_TIERS.includes(tier.effectiveTier) || mode.securityLane === true;
  const downgraded = F.modeInvariant(run);
  if (downgraded !== null) return failure('RUN_FAILED', { reason: 'mode-invariant', error: downgraded, precheck });
  const cap = run.policy && Number.isInteger(run.policy.maxConcurrentAgents) ? run.policy.maxConcurrentAgents : DEFAULT_MAX_CONCURRENT;
  run.maxConcurrentAgents = cap;

  // 9-11. briefs, waves, deadlines. A brief the renderer refuses cannot be reviewed mechanically: full mode.
  let agents;
  try {
    agents = buildReviewAgents(run, deps, { now: startedAt });
  } catch (error) {
    if (isFull) return terminate(run, 'failed', failure('RUN_FAILED', { runId, headSha, reason: `brief-refused: ${msg(error)}`, mode, tier, dispatched: [], precheck }), 'prepare', startedAt, deps);
    return terminate(run, 'needs-full-mode', failure('NEEDS_FULL_MODE', { runId, headSha, mode: { ...mode, reasons: [...mode.reasons, 'brief-refused'] }, tier, reason: `brief-refused: ${msg(error)}`, dispatched: [], precheck }), 'prepare', startedAt, deps);
  }
  const groups = S.chunk(agents, cap);
  run.waves = groups.map((group, index) => ({ round: 'review', wave: index + 1, of: groups.length, status: 'planned', agents: group }));
  const now = deps.now();
  dispatchWave(run, run.waves[0], now, deps, tracer);
  run.phase = 'review-dispatched';
  logCall(run, 'prepare', startedAt, deps);
  saveRun(deps, run);
  return { ...manifestOf(run, run.waves[0]), precheck, prState: run.prState };
}

/* ------------------------------------------------------------------- collect */

function validateCollect(input) {
  if (!isObject(input)) return 'the payload must be a JSON object';
  for (const key of Object.keys(input)) if (!COLLECT_KEYS.includes(key)) return `unknown payload key ${JSON.stringify(key)}`;
  if (!isText(input.repoRoot) || !path.isAbsolute(input.repoRoot)) return 'repoRoot must be an absolute path';
  if (!isValidRunId(input.runId)) return 'runId must be a valid run id';
  if (input.now !== undefined && !Number.isFinite(typeof input.now === 'string' ? Date.parse(input.now) : input.now)) return 'now must be epoch milliseconds or an ISO timestamp';
  if (input.adjudications !== undefined && !Array.isArray(input.adjudications)) return 'adjudications must be an array';
  if (input.triage !== undefined && !isObject(input.triage)) return 'triage must be a JSON object';
  return null;
}

function expectedOf(wave) {
  return wave.agents.map((a) => ({ name: a.name, role: a.role, dispatchedAt: a.dispatchedAt, deadlineAt: a.deadlineAt, ...(a.sliceId !== undefined ? { sliceId: a.sliceId, lens: a.lens, paths: a.paths } : {}), ...(a.candidateIds !== undefined ? { candidateIds: a.candidateIds } : {}) }));
}

/** Records one collected wave in the run and ends its agents' spans. */
function recordWave(run, wave, collected, now, tracer) {
  for (const record of collected.agents) {
    const agent = wave.agents.find((a) => a.name === record.name);
    agent.state = record.state;
    agent.reason = record.reason;
    if (Number.isFinite(record.arrivedAt)) agent.arrivedAt = record.arrivedAt;
    tracer.end(agent.spanId, record.state === 'arrived' ? 'ok' : record.state, { state: record.state, reason: record.reason });
  }
  wave.status = 'collected';
  wave.collectedAt = now;
  wave.result = { findings: collected.findings, votes: collected.votes, incompleteVerifiers: collected.incompleteVerifiers, reviewedSlices: collected.reviewedSlices, unreviewedDetail: collected.unreviewedDetail, warnings: collected.warnings };
}

/** Everything after the review round: complete and dedupe the findings, the lane, the coverage, the verification plan. */
function processReview(run, deps, { deferVerification = false } = {}) {
  const reviewWaves = run.waves.filter((w) => w.round === 'review');
  const agents = reviewWaves.flatMap((w) => w.agents);
  const raw = reviewWaves.flatMap((w) => w.result.findings);

  // A finding labelled `pre-existing` never blocks, and the label is the agent's own word about provenance: it stands only
  // when the cited lines lie outside the PR's diff (S.gradePreExisting). The diff is read once, and only when a claim needs it.
  const claimsPreExisting = raw.some((finding) => finding.reviewer !== LANE_NAME && normalizeSeverity(finding.severity) === 'pre-existing');
  const snapshotDir = run.prepared.snapshotDir;
  // The file a citation names, looked up once per path: exactly spelled, a regular file of the head snapshot, never followed,
  // with its line count (S.gradePreExisting then refuses a label whose path names no such file or whose line is past its end).
  // A file system that cannot look it up, or throws, names nothing.
  const headFiles = new Map();
  const headFileOf = (rel) => {
    if (!headFiles.has(rel)) {
      let found = null;
      try {
        found = typeof snapshotDir === 'string' && typeof deps.fs.headFile === 'function' ? deps.fs.headFile(snapshotDir, rel) : null;
      } catch (_error) {
        found = null;
      }
      headFiles.set(rel, isObject(found) ? found : null);
    }
    return headFiles.get(rel);
  };
  const linesOf = (rel) => (headFileOf(rel) === null ? null : headFileOf(rel).lines);
  const diff = claimsPreExisting ? { index: readDiffIndex(deps, run.prepared.rangeDiff), changedPaths: run.changedPaths, snapshotDir, exists: (rel) => headFileOf(rel) !== null, lines: linesOf } : null;

  const completed = [];
  const laneFindings = [];
  let nextId = 0;
  let nextLaneId = 0;
  for (const finding of raw) {
    const name = finding.reviewer;
    const { reviewer, ...own } = finding;
    const entry = S.completeFinding(own, name, name === LANE_NAME ? `s${(nextLaneId += 1)}` : `f${(nextId += 1)}`);
    if (name === LANE_NAME) laneFindings.push(entry);
    else completed.push(diff === null ? entry : S.gradePreExisting(entry, diff));
  }
  const deduped = dedupeFindings(completed);
  if (!Array.isArray(deduped)) return failure('RUN_FAILED', { reason: 'dedupe-refused', error: deduped.reason });
  run.candidates = deduped;

  // coverage: a slice is reviewed only when no wave lists it unreviewed
  const unreviewed = new Map();
  for (const wave of reviewWaves) for (const detail of wave.result.unreviewedDetail) {
    const known = unreviewed.get(detail.sliceId) || { sliceId: detail.sliceId, reasons: [], missingPaths: [] };
    known.reasons.push(...detail.reasons);
    for (const p of detail.missingPaths) if (!known.missingPaths.includes(p)) known.missingPaths.push(p);
    unreviewed.set(detail.sliceId, known);
  }
  // every path must be read under the plan's distinct lenses (verifyCoverage); a slice with any pass missing is already in `unreviewed`
  const reviewedBy = agents.filter((a) => a.role === 'reviewer' && a.sliceId !== undefined && !unreviewed.has(a.sliceId)).map((a) => ({ sliceId: a.sliceId, lens: a.lens, reviewer: a.name, paths: a.paths }));
  const coverage = verifyCoverage({ slices: run.slices, reviewedBy, mode: run.depth.mode, changedPaths: run.changedPaths });
  run.coverage = { ok: coverage.ok, complete: coverage.ok === true && coverage.covered === true, reviewedSlices: coverage.reviewedSlices || [], unreviewedSlices: coverage.unreviewedSlices || run.slices.map((s) => s.id), uncovered: coverage.uncovered || run.changedPaths.slice(), detail: [...unreviewed.values()].filter((d) => d.sliceId !== LANE_COVERAGE_SLICE) };

  // the security lane: only a lane that arrived AND covered every changed path is ever `clean`
  const lane = agents.find((a) => a.name === LANE_NAME);
  if (lane === undefined) {
    run.security = { status: 'not-run', findings: [], reason: 'the tier does not call for the security lane' };
  } else if (lane.state !== 'arrived') {
    run.security = { status: 'not-run', findings: [], reason: `the security lane did not return (${lane.state}${lane.reason ? `: ${lane.reason}` : ''})` };
  } else if (unreviewed.has(LANE_COVERAGE_SLICE)) {
    run.security = { status: 'unavailable', findings: laneFindings, reason: `the security lane did not cover: ${unreviewed.get(LANE_COVERAGE_SLICE).missingPaths.join(', ') || 'every changed path'}` };
  } else {
    run.security = laneFindings.length > 0 ? { status: 'findings', findings: laneFindings } : { status: 'clean', findings: [] };
  }

  // verification plan: K distinct fresh verifiers per candidate, nobody on their own finding. A full run plans it only
  // after the orchestrator's triage, which may add candidates (planVerifyRound is then called with the grown list).
  if (deferVerification) return null;
  return planVerifyRound(run, deps);
}

/** Plans and briefs the verify round for `run.candidates`. Null on success, a RUN_FAILED answer otherwise. */
function planVerifyRound(run, deps) {
  const deduped = run.candidates;
  const k = run.depth.verifiersPerCandidate;
  const plan = S.planVerifierPool({ candidates: deduped, mode: run.depth.mode, k });
  if (plan.ok !== true) return failure('RUN_FAILED', { reason: 'verify-plan-refused', error: plan.reason });
  run.assignment = plan.assignments;
  run.unbriefable = [];
  run.verifyAgents = [];
  if (k === 0 || deduped.length === 0) return null;

  const dir = runDirOf(run.repoRoot, run.runId);
  const sections = new Map();
  for (const candidate of deduped) {
    try {
      const file = S.locationFile(candidate.locationOrLink);
      sections.set(candidate.id, deps.renderBrief('verifier', { claim: candidate.failureMode, location: candidate.locationOrLink, paths: file === null ? [] : [file], snapshotDir: run.prepared.snapshotDir }));
    } catch (error) {
      run.unbriefable.push({ id: candidate.id, reason: msg(error) });
    }
  }
  for (const entry of plan.agents) {
    const ids = entry.candidates.filter((id) => sections.has(id));
    if (ids.length === 0) continue;
    const name = entry.verifier;
    const record = { name, role: 'verifier', candidateIds: ids, briefPath: path.join(dir, 'briefs', `${name}.md`), outPath: path.join(dir, 'results', 'verify', `out-${name}.json`) };
    const body = ids.map((id) => `### Candidate ${id}\n\n${sections.get(id).replace(/\s*$/, '\n')}`).join('\n---\n\n');
    deps.fs.mkdirp(path.dirname(record.briefPath), 0o700);
    deps.fs.writeAtomic(record.briefPath, `# Findings to settle (${ids.length})\n\nEach finding below is a separate claim. Settle each on its own.\n\n${body}\n${S.verifierContract(record)}`, 0o600);
    run.verifyAgents.push(record);
  }
  return null;
}

function addWaves(run, round, agents) {
  const groups = S.chunk(agents, run.maxConcurrentAgents);
  groups.forEach((group, index) => run.waves.push({ round, wave: index + 1, of: groups.length, status: 'planned', agents: group }));
}

/* ------------------------------------------------------------- finalisation */

function buildLedger(run) {
  const verifyWaves = run.waves.filter((w) => w.round === 'verify' && w.status === 'collected');
  const votes = verifyWaves.flatMap((w) => w.result.votes);
  const incompleteVerifiers = verifyWaves.flatMap((w) => w.result.incompleteVerifiers);
  const agents = verifyWaves.flatMap((w) => w.agents.map((a) => ({ name: a.name, role: a.role, state: a.state, candidateIds: a.candidateIds })));
  const input = toVotesInput({ votes, incompleteVerifiers, agents, findings: [] }, { depth: run.depth.mode, expectedVerifiers: run.depth.verifiersPerCandidate, candidates: run.candidates });
  if (input.ok === false) return { ok: false, reason: input.reason };
  const unbriefable = new Map(run.unbriefable.map((u) => [u.id, u.reason]));
  const findings = input.findings.map((finding) => (unbriefable.has(finding.id) ? { ...finding, incompleteVerifiers: [...(finding.incompleteVerifiers || []), { verifier: '(unbriefable)', reason: `unbriefable: ${unbriefable.get(finding.id)}` }] } : finding));
  const tally = tallyVotes({ findings, depth: input.depth, expectedVerifiers: input.expectedVerifiers, assignment: run.assignment });
  if (tally.ok !== true) return { ok: false, reason: `votes blocked: ${tally.reason}` };
  const byId = new Map(tally.findings.map((f) => [String(f.id), f]));
  // The ledger is every deduped candidate, unchanged, with its verification outcome UNDER `verification`: tally fields
  // such as `reason` would otherwise read as a ledger deferral reason.
  const ledger = run.candidates.map((candidate) => {
    const t = byId.get(String(candidate.id));
    return { ...candidate, verification: { outcome: t.outcome, reason: t.reason, authorLabel: t.authorLabel, presented: t.presented, tally: t.tally, assigned: t.assigned, incompleteVerifiers: t.incompleteVerifiers, ignoredVotes: t.ignoredVotes } };
  });
  return { ok: true, ledger, tally };
}

function testsFact(baseline) {
  if (!isObject(baseline) || baseline.ran !== true || baseline.timedOut === true || !Number.isInteger(baseline.exitCode)) return undefined;
  const files = Array.isArray(baseline.files) ? baseline.files.length : 0;
  return { exitCode: baseline.exitCode, skipped: false, command: `relevant test files only (${files} file${files === 1 ? '' : 's'}), not the full suite: ${(baseline.command || []).join(' ')}` };
}

/** One read, and ONE retry of it, before it is called unavailable. */
async function twice(fn) {
  let result = await settle(fn);
  if (!isObject(result) || result.ok !== true) result = await settle(fn);
  return result;
}

async function treeOf(deps, sha) {
  if (!SHA.test(String(sha))) return undefined;
  const r = await settle(() => deps.git(['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`]));
  const out = isObject(r) && r.status === 0 ? String(r.stdout).trim().toLowerCase() : '';
  return SHA.test(out) ? out : undefined;
}

/**
 * The gate stage, from the host: reviews, the head re-read, tree ids from the local object database, protection,
 * unavailable[] for reads that failed twice, then tier -> approvals -> gate exactly as merge-gate.md 10d/10e.
 * Returns `{invalid}` (head moved / unreadable) or the graded pieces.
 */
async function gateStage(run, built, deps, tracer) {
  const unavailable = [];
  const warnings = [];
  const reviewsRead = await twice(() => deps.readReviews());
  if (reviewsRead.ok !== true || !Array.isArray(reviewsRead.reviews)) unavailable.push('reviews');
  const protectionRead = await twice(() => deps.readProtection(run.baseRefName));
  if (protectionRead.ok !== true) unavailable.push('branch-protection');

  const head = await readHead(deps);
  if (!head.ok) return { invalid: failure('RUN_FAILED', { reason: 'head-unreadable', error: head.error, runId: run.runId }) };
  if (head.headSha !== run.headSha) return { invalid: failure('RUN_INVALIDATED', { reason: 'head-moved', runId: run.runId, expectedHead: run.headSha, currentHead: head.headSha }), moved: true };
  if (head.pr.state !== 'OPEN') return { invalid: notOpen(head.pr.state, run.runId), moved: false };

  const headTreeSha = await treeOf(deps, run.headSha);
  if (headTreeSha === undefined) warnings.push('head-tree-unreadable: only approvals given on the head commit itself are counted');
  const trees = new Map();
  const reviews = [];
  for (const review of reviewsRead.ok === true && Array.isArray(reviewsRead.reviews) ? reviewsRead.reviews : []) {
    if (!isObject(review)) continue;
    const commit = typeof review.commitSha === 'string' ? review.commitSha.toLowerCase() : null;
    if (commit !== null && commit !== run.headSha && !trees.has(commit)) trees.set(commit, await treeOf(deps, commit));
    reviews.push({ ...review, ...(commit !== null && trees.get(commit) ? { treeSha: trees.get(commit) } : {}) });
  }

  // Who wrote the PR is not something the runner can read: the author's login cannot say it (an agent PR is committed under
  // the maintainer's own login), so `agentAuthored` is the caller's statement, passed on as given. The answer says so, so a
  // relaxation (or a credit) that rests on that word is visible instead of silent. Absent is the strictest reading.
  if (run.agentAuthored === true) warnings.push('agent-authored-unverified: the caller stated agentAuthored:true, so a "Directed by:" line in the PR body credits the person it names as one approval; the runner cannot verify who wrote this pull request');
  else if (run.agentAuthored === false) warnings.push('agent-authored-unverified: the caller stated agentAuthored:false, so no "Directed by:" line was required and nobody was credited as the director; the runner cannot verify who wrote this pull request');
  const description = checkDescription({ body: head.pr.body, agentAuthored: run.agentAuthored });
  const policy = run.policy === null ? undefined : run.policy;
  const approvals = evaluateApprovals({ reviews, headSha: run.headSha, headTreeSha, tier: run.tier, policy, author: run.author, directedBy: description.directedBy || undefined, agentAuthored: run.agentAuthored });
  const span = tracer.start('gate', 'gate', { headSha: run.headSha });
  const gate = evaluateGate({ ledger: built.ledger, approvals, tier: run.tier, description, security: run.security, headSha: run.headSha, policy, unavailable });
  const disposition = buildDispositionChoices({ ledger: built.ledger, security: run.security, votes: built.tally, policy, headSha: run.headSha });
  tracer.end(span, gate.mergeable === true ? 'ok' : 'blocked', { mergeable: gate.mergeable, blockers: gate.blockers.length });
  const gated = { ...gate, dispositionChoices: disposition.dispositionChoices, dispositionGroups: disposition.groups, mergeConfirmation: disposition.mergeConfirmation, ...(disposition.ok === true ? {} : { dispositionReason: disposition.reason }) };

  const actionable = built.ledger.filter((entry) => isActionable(entry)).length;
  const deferred = built.ledger.filter((entry) => !isActionable(entry) && entry.disposition === 'deferred').length;
  const tests = testsFact(run.baseline);
  const reviewStatus = deriveStatus({
    baseSha: run.baseSha,
    headSha: run.headSha,
    reviewedHeadSha: run.headSha,
    ...(headTreeSha === undefined ? {} : { reviewedTreeSha: headTreeSha, headTreeSha }),
    findingCounts: { total: built.ledger.length, actionable, deferred },
    // No usable baseline (no relevant test files, a timed-out run, none at all) is a run that did not happen, never a
    // failure it did not have: recorded as skipped, so the status reads `tests skipped` and can never be complete.
    tests: tests === undefined ? { skipped: true, command: 'none: the baseline run produced no usable result (no relevant test files, a timed-out run or no run)' } : tests,
    roundsUsed: 0,
    ...(run.policy && Number.isInteger(run.policy.roundCap) ? { roundCap: run.policy.roundCap } : {}),
    reportPath: statePath(run.pr, run.repoRoot),
  });
  return { gate: gated, approvals, description, reviewStatus, headTreeSha, tests, protection: assessProtection(protectionRead, run.baseRefName, { required: approvals.humansRequired }), unavailable, warnings, headState: head.pr.state };
}

function reducedReviewNotice(run, built, notReviewed, stage) {
  const lines = [];
  if (notReviewed.unreviewedSlices.length > 0) lines.push(`NOT REVIEWED: slice(s) ${notReviewed.unreviewedSlices.join(', ')}; path(s) ${notReviewed.unreviewedPaths.join(', ')}`);
  if (run.security.status !== 'clean') lines.push(`security lane ${run.security.status}${run.security.reason ? `: ${run.security.reason}` : ''}`);
  if (built.tally.verification !== 'performed') lines.push(`verification ${built.tally.verification}${built.tally.reason ? `: ${built.tally.reason}` : ''}`);
  if (notReviewed.unbriefable.length > 0) lines.push(`unbriefable candidate(s) kept, unverified: ${notReviewed.unbriefable.map((u) => u.id).join(', ')}`);
  const regraded = built.ledger.filter((entry) => entry.claimedSeverity !== undefined);
  if (regraded.length > 0) lines.push(`graded Important, not pre-existing as the reviewer called them, because the diff does not bear the label out: ${regraded.map((entry) => `${entry.id} (${entry.locationOrLink})`).join(', ')}`);
  if (stage.tests === undefined) lines.push('tests not shown: no baseline run, a timed-out one, or no relevant test files');
  else lines.push(`tests: the baseline ran the relevant test files only (exit ${stage.tests.exitCode}), not the full suite`);
  return lines.join('\n');
}

function notReviewedOf(run) {
  const agents = run.waves.filter((w) => w.status === 'collected').flatMap((w) => w.agents);
  const verifyWaves = run.waves.filter((w) => w.round === 'verify' && w.status === 'collected');
  return {
    unreviewedSlices: run.coverage.unreviewedSlices,
    unreviewedPaths: run.coverage.uncovered,
    incompleteVerifiers: verifyWaves.flatMap((w) => w.result.incompleteVerifiers),
    unbriefable: run.unbriefable,
    expiredAgents: agents.filter((a) => a.state !== 'arrived').map((a) => ({ name: a.name, role: a.role, state: a.state, reason: a.reason })),
  };
}

/** The final computation, from a run whose waves are all collected. `ledger`/`tally` may come from an adjudication. */
async function finalise(run, built, deps, now, startedAt, tracer, extra) {
  const stage = await gateStage(run, built, deps, tracer);
  if (stage.invalid) return { invalid: stage.invalid, moved: stage.moved === true };

  const notReviewed = notReviewedOf(run);
  const adjudicate = S.adjudicateList(built.ledger);
  const reducedReview = reducedReviewNotice(run, built, notReviewed, stage);
  const fullFields = run.mode.mode === 'full' ? { reReview: run.reReview, triage: run.triage } : {};
  const state = {
    ...stage.reviewStatus,
    prId: run.pr,
    runId: run.runId,
    mode: run.mode.mode,
    tier: run.tier,
    depth: { mode: run.depth.mode, reasons: run.depth.reasons, reviewersPerSlice: run.depth.reviewersPerSlice, verifiersPerCandidate: run.depth.verifiersPerCandidate },
    verification: { verification: built.tally.verification, reason: built.tally.reason, recoveryAction: built.tally.recoveryAction },
    reducedReview,
    ledger: built.ledger,
    security: run.security,
    notReviewed,
    gate: { mergeable: stage.gate.mergeable, blockers: stage.gate.blockers },
    ...fullFields,
    ...(extra.adjudications ? { adjudicatedBy: 'orchestrator', adjudications: extra.adjudications } : {}),
  };
  const written = await settle(() => deps.writeState(statePath(run.pr, run.repoRoot), state));
  if (!isObject(written) || written.ok !== true) {
    return { invalid: failure('RUN_FAILED', { reason: 'state-write-failed', error: isObject(written) ? written.reason || written.error : 'no answer', runId: run.runId }), moved: false };
  }

  logCall(run, extra.call, startedAt, deps, extra.adjudications !== undefined, extra.flags || {});
  const metrics = S.computeMetrics(run, deps.now());
  const answer = {
    ok: true,
    status: adjudicate.length > 0 ? 'ADJUDICATE' : 'DONE',
    runId: run.runId,
    headSha: run.headSha,
    baseSha: run.baseSha,
    prState: run.prState,
    mode: run.mode,
    ...fullFields,
    tier: run.tier,
    depth: { mode: run.depth.mode, verifiersPerCandidate: run.depth.verifiersPerCandidate, reviewersPerSlice: run.depth.reviewersPerSlice },
    gate: stage.gate,
    reviewStatus: stage.reviewStatus,
    ledger: built.ledger,
    votes: { verification: built.tally.verification, reason: built.tally.reason, recoveryAction: built.tally.recoveryAction, outcomes: built.tally.findings.map((f) => ({ id: f.id, outcome: f.outcome, reason: f.reason, authorLabel: f.authorLabel, tally: f.tally })) },
    security: run.security,
    coverage: { complete: run.coverage.complete && run.security.status !== 'not-run', unreviewedSlices: run.coverage.unreviewedSlices, uncovered: run.coverage.uncovered },
    notReviewed,
    approvals: stage.approvals,
    protection: stage.protection,
    precheck: run.precheck,
    unavailable: stage.unavailable,
    warnings: stage.warnings,
    reducedReview,
    statePath: written.path,
    metrics,
    ...(adjudicate.length > 0 ? { adjudicate } : {}),
    ...(extra.adjudications ? { adjudicatedBy: 'orchestrator', adjudications: extra.adjudications } : {}),
  };
  deps.fs.writeAtomic(path.join(runDirOf(run.repoRoot, run.runId), 'final.json'), `${JSON.stringify(redactor(deps)(answer), null, 2)}\n`, 0o600);
  run.phase = 'done';
  run.votesResult = built.tally;
  run.finalLedger = built.ledger;
  run.metrics = metrics;
  if (extra.adjudications) run.adjudications = extra.adjudications;
  saveRun(deps, run);
  return { answer };
}

/** Validates and applies adjudications; only findings that were LISTED can be decided, and no decision closes an Important. */
function applyAdjudications(ledger, listed, adjudications, now) {
  const allowed = new Set(listed.map((l) => String(l.id)));
  const seen = new Set();
  for (const item of adjudications) {
    if (!isObject(item) || !isText(String(item.id)) || !ADJUDICATION_DISPOSITIONS.includes(item.disposition) || !isText(item.reason)) {
      return { ok: false, reason: 'each adjudication needs id, disposition (fix | deferred | not-applicable) and a reason' };
    }
    if (!allowed.has(String(item.id))) return { ok: false, reason: `finding ${JSON.stringify(item.id)} was not listed for adjudication` };
    if (seen.has(String(item.id))) return { ok: false, reason: `finding ${JSON.stringify(item.id)} is adjudicated twice` };
    seen.add(String(item.id));
  }
  const byId = new Map(adjudications.map((a) => [String(a.id), a]));
  const next = ledger.map((entry) => {
    const decision = byId.get(String(entry.id));
    if (decision === undefined) return entry;
    return {
      ...entry,
      disposition: decision.disposition,
      uncertain: false,
      ...(decision.disposition === 'deferred' ? { reason: decision.reason } : {}),
      adjudicatedBy: 'orchestrator',
      adjudication: { by: 'orchestrator', disposition: decision.disposition, reason: decision.reason, at: new Date(now).toISOString() },
    };
  });
  return { ok: true, ledger: next };
}

/** The TRIAGE answer: the full-mode stop where the orchestrating model may add candidates, and nothing else. Dispatches nothing. */
function triageManifest(run) {
  return {
    ok: true,
    status: 'TRIAGE',
    runId: run.runId,
    headSha: run.headSha,
    mode: run.mode,
    tier: run.tier,
    reReview: run.reReview,
    depth: { mode: run.depth.mode, reviewersPerSlice: run.depth.reviewersPerSlice, verifiersPerCandidate: run.depth.verifiersPerCandidate },
    dispatched: [],
    candidates: run.candidates.map((c) => ({ id: c.id, locationOrLink: c.locationOrLink, severity: c.severity, failureMode: c.failureMode, source: c.source })),
    coverage: { complete: run.coverage.complete, unreviewedSlices: run.coverage.unreviewedSlices, uncovered: run.coverage.uncovered },
    security: { status: run.security.status, findings: run.security.findings.length, ...(run.security.reason === undefined ? {} : { reason: run.security.reason }) },
    maxAdditionalCandidates: F.MAX_ADDITIONAL_CANDIDATES,
    next: `node review-run-cli.js collect  (payload {"repoRoot": ${JSON.stringify(run.repoRoot)}, "runId": ${JSON.stringify(run.runId)}, "triage": {"additionalCandidates": []}})`,
    rules: [...RULES, ...TRIAGE_RULES],
  };
}

/**
 * One collect call while the run waits for triage (phase `triage`). Returns an answer to hand back (the TRIAGE answer again,
 * a refusal, a failure, or the verify wave), or null when triage is complete and nothing needs verifying, so collect goes on
 * to the ledger. Triage only ever GROWS `run.candidates`: nothing here removes, edits or closes one.
 */
function triageStep(run, input, deps, tracer, startedAt, now) {
  if (input.triage === undefined) {
    logCall(run, 'collect', startedAt, deps, false, { triage: true });
    saveRun(deps, run);
    return triageManifest(run);
  }
  const validated = F.validateTriage(input.triage);
  if (validated.ok !== true) return failure('RUN_FAILED', { reason: 'triage-refused', error: validated.reason, runId: run.runId });

  // A cited location must be a regular file of the head snapshot, exactly spelled and never followed, with the line in it:
  // a verifier is briefed with that path, so a path the snapshot does not hold (a home-relative or absolute path included)
  // is never passed on.
  for (const raw of validated.additional) {
    const cited = /^(.+):(\d+)(?:-(\d+))?$/.exec(raw.locationOrLink);
    let found = null;
    try {
      found = typeof run.prepared.snapshotDir === 'string' && typeof deps.fs.headFile === 'function' ? deps.fs.headFile(run.prepared.snapshotDir, cited[1]) : null;
    } catch (_error) {
      found = null;
    }
    const last = Number(cited[3] === undefined ? cited[2] : cited[3]);
    if (!isObject(found) || !(Number(cited[2]) >= 1 && last >= Number(cited[2]) && last <= found.lines)) {
      return failure('RUN_FAILED', { reason: 'triage-refused', error: `${raw.locationOrLink} is not a line of a regular file of the head snapshot (spell the repository-relative path exactly)`, runId: run.runId });
    }
  }

  const used = run.candidates.flatMap((c) => [c.id, ...(Array.isArray(c.mergedFrom) ? c.mergedFrom.map((m) => m.id) : [])]);
  const top = used.map((id) => /^f(\d+)$/.exec(String(id))).filter((m) => m !== null).map((m) => Number(m[1]));
  const first = Math.max(0, ...top) + 1;
  const entries = validated.additional.map((raw, index) => S.completeFinding(raw, F.ORCHESTRATOR, `f${first + index}`));
  // An entry the dedupe would merge with an existing candidate is dropped: the existing candidate stays exactly as it was
  // (id, source, severity), so triage can never displace or re-grade one. Only a distinct entry is appended, unchanged.
  let candidates = run.candidates;
  for (const entry of entries) {
    const combined = dedupeFindings([...candidates, entry]);
    if (!Array.isArray(combined)) return failure('RUN_FAILED', { reason: 'triage-refused', error: combined.reason, runId: run.runId });
    if (combined.length > candidates.length) candidates = [...candidates, entry];
  }
  const kept = entries.filter((e) => candidates.some((c) => c.id === e.id)).map((e) => e.id);
  run.candidates = candidates;
  run.triage = { turns: 1, requested: entries.length, additionalCandidateIds: kept, mergedIntoExisting: entries.length - kept.length, at: new Date(now).toISOString() };

  const failed = planVerifyRound(run, deps);
  if (failed !== null) return terminate(run, 'failed', { ...failed, runId: run.runId }, 'collect', startedAt, deps);
  run.phase = 'triaged';
  if (run.verifyAgents.length > 0) {
    addWaves(run, 'verify', run.verifyAgents);
    return emit(run, run.waves.find((w) => w.status === 'planned'), deps, tracer, startedAt, now, { triage: true });
  }
  saveRun(deps, run);
  return null;
}

async function collectRun(input, deps) {
  const startedAt = deps.now();
  const invalid = validateCollect(input);
  if (invalid !== null) return failure('RUN_FAILED', { reason: 'invalid-input', error: invalid });
  const now = input.now === undefined ? startedAt : typeof input.now === 'string' ? Date.parse(input.now) : input.now;

  const run = loadRun(deps, input.repoRoot, input.runId);
  if (run === null) return failure('RUN_FAILED', { reason: 'run-not-found', error: `no run ${input.runId} under ${input.repoRoot}` });
  if (run === undefined) return failure('RUN_FAILED', { reason: 'run-unreadable', error: 'run.json is not a run of this version' });
  const tracer = safeTracer(deps, run.traceRunId);

  if (['invalidated', 'needs-full-mode', 'failed'].includes(run.phase)) return run.result;

  // Every other call, in every stored phase (a finished run's replay included), first checks the record against its own mode:
  // the stored label must be selectMode's answer for the stored tier, and a full run must still be Deep, with its lane.
  const downgraded = F.modeInvariant(run);
  if (downgraded !== null) return terminate(run, 'failed', failure('RUN_FAILED', { reason: 'mode-invariant', error: downgraded, runId: run.runId }), 'collect', startedAt, deps);
  if (input.triage !== undefined && run.phase !== 'triage') return failure('RUN_FAILED', { reason: 'triage-not-pending', error: `run ${run.runId} is not waiting for triage (phase ${run.phase})`, runId: run.runId });

  // ---- a finished run: the stored answer, or an adjudication of what it listed
  if (run.phase === 'done') {
    // The stored answer is for the head the run reviewed. It is returned (or adjudicated) only while the host still states
    // that head on an OPEN PR: a head that moved invalidates it whatever it said (AC4). Nothing is recorded here, so if
    // the head comes back to the reviewed commit the stored answer is that commit's answer again.
    const live = await readHead(deps);
    if (!live.ok) return failure('RUN_FAILED', { reason: 'head-unreadable', error: live.error, runId: run.runId });
    if (live.headSha !== run.headSha) {
      return failure('RUN_INVALIDATED', { reason: 'head-moved', runId: run.runId, expectedHead: run.headSha, currentHead: live.headSha, error: 'the head moved after this run finished: its stored answer is for the old head and is not returned' });
    }
    if (live.pr.state !== 'OPEN') return notOpen(live.pr.state, run.runId);
    const stored = deps.fs.readText(path.join(runDirOf(run.repoRoot, run.runId), 'final.json'));
    let final = null;
    try {
      final = stored === null ? null : JSON.parse(stored);
    } catch (_error) {
      final = null;
    }
    if (!isObject(final)) return failure('RUN_FAILED', { reason: 'final-unreadable', error: 'final.json of a done run cannot be read', runId: run.runId });
    if (input.adjudications === undefined) return final;
    const listed = S.adjudicateList(run.finalLedger);
    const applied = applyAdjudications(run.finalLedger, listed, input.adjudications, now);
    if (applied.ok !== true) return failure('RUN_FAILED', { reason: 'adjudication-refused', error: applied.reason, runId: run.runId });
    const history = [...(run.adjudications || []), ...input.adjudications];
    const outcome = await finalise(run, { ledger: applied.ledger, tally: run.votesResult }, deps, now, startedAt, tracer, { call: 'collect', adjudications: history });
    // The stored answer stays the answer for the old head: a moved head decides nothing new.
    return outcome.invalid ? outcome.invalid : outcome.answer;
  }

  // ---- 1. the head, re-read: never advance on an unconfirmed head
  const head = await readHead(deps);
  if (!head.ok) return failure('RUN_FAILED', { reason: 'head-unreadable', error: head.error, runId: run.runId });
  if (head.headSha !== run.headSha) {
    return terminate(run, 'invalidated', failure('RUN_INVALIDATED', { reason: 'head-moved', runId: run.runId, expectedHead: run.headSha, currentHead: head.headSha }), 'collect', startedAt, deps);
  }
  if (head.pr.state !== 'OPEN') return notOpen(head.pr.state, run.runId);

  // ---- 1b. a full run waits here for the orchestrator's triage; it cannot reach the ledger without passing through it
  if (run.phase === 'triage') {
    const triaged = triageStep(run, input, deps, tracer, startedAt, now);
    if (triaged !== null) return triaged;
  }

  // ---- 2. the outstanding wave
  const wave = run.waves.find((w) => w.status === 'dispatched');
  if (wave !== undefined) {
    const collected = await settle(() => deps.collectResults({ expected: expectedOf(wave), dir: path.join(runDirOf(run.repoRoot, run.runId), 'results', wave.round), now }));
    if (!isObject(collected) || !Array.isArray(collected.agents)) {
      return failure('RUN_FAILED', { reason: 'collect-refused', error: isObject(collected) ? collected.reason || collected.error : 'no answer', runId: run.runId });
    }
    const pending = collected.agents.filter((a) => a.pending === true);
    if (pending.length > 0) {
      const earliest = Math.min(...pending.map((a) => a.deadlineAt));
      logCall(run, 'collect', startedAt, deps);
      saveRun(deps, run);
      return { ok: true, status: 'PENDING', runId: run.runId, round: wave.round, wave: `${wave.wave} of ${wave.of}`, waitingOn: pending.map((a) => a.name), retryAfterMs: Math.max(1000, Math.min(15000, earliest - now)), earliestDeadlineAt: earliest, earliestDeadlineAtIso: new Date(earliest).toISOString() };
    }
    recordWave(run, wave, collected, now, tracer);
    saveRun(deps, run);
  }

  // ---- 3. what comes next: another planned wave, the verify round, or the end
  const next = run.waves.find((w) => w.status === 'planned');
  if (next !== undefined) return emit(run, next, deps, tracer, startedAt, now);

  if (run.candidates === undefined) {
    const isFull = run.mode.mode === 'full';
    const failed = processReview(run, deps, { deferVerification: isFull });
    if (failed !== null) return terminate(run, 'failed', { ...failed, runId: run.runId }, 'collect', startedAt, deps);
    if (isFull) {
      run.phase = 'triage';
      run.triage = { turns: 0, requested: 0, additionalCandidateIds: [], mergedIntoExisting: 0 };
      logCall(run, 'collect', startedAt, deps, false, { triage: true });
      saveRun(deps, run);
      return triageManifest(run);
    }
    if (run.verifyAgents.length > 0) {
      addWaves(run, 'verify', run.verifyAgents);
      return emit(run, run.waves.find((w) => w.status === 'planned'), deps, tracer, startedAt, now);
    }
    saveRun(deps, run);
  }

  const built = buildLedger(run);
  if (built.ok !== true) return terminate(run, 'failed', failure('RUN_FAILED', { reason: 'ledger-refused', error: built.reason, runId: run.runId }), 'collect', startedAt, deps);
  const validation = validateLedger(built.ledger);
  if (validation.ok !== true) return terminate(run, 'failed', failure('RUN_FAILED', { reason: 'ledger-unusable', error: `findings fail validation: ${validation.offendingIds.join(', ')}`, runId: run.runId }), 'collect', startedAt, deps);

  const outcome = await finalise(run, built, deps, now, startedAt, tracer, { call: 'collect', flags: run.phase === 'triaged' ? { triage: true } : {} });
  if (outcome.invalid) {
    return outcome.moved ? terminate(run, 'invalidated', outcome.invalid, 'collect', startedAt, deps) : outcome.invalid;
  }
  return outcome.answer;
}

function emit(run, wave, deps, tracer, startedAt, now, flags = {}) {
  try {
    dispatchWave(run, wave, now, deps, tracer);
  } catch (error) {
    return terminate(run, 'failed', failure('RUN_FAILED', { reason: 'dispatch-failed', error: msg(error), runId: run.runId }), 'collect', startedAt, deps);
  }
  run.phase = wave.round === 'review' ? 'review-dispatched' : 'verify-dispatched';
  logCall(run, 'collect', startedAt, deps, false, flags);
  saveRun(deps, run);
  return manifestOf(run, wave);
}

module.exports = { prepareRun, collectRun, PREPARE_KEYS, COLLECT_KEYS, RUN_SUBDIR, LANE_NAME, SCHEMA, RULES };
