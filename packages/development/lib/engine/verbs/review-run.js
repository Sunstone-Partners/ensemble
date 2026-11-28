'use strict';

/**
 * TRD-017 (TRD-2026-d571763f): `ensemble review run`, the local review loop host.
 *
 * `review-run-cli` already owns the whole review: it prepares the round, writes every brief,
 * tallies every vote, derives the status and records the state report. This verb is only the
 * host that lets a model drive it through the engine's one envelope. It composes no brief,
 * counts no vote and sets no status; each of those is read off the runner's answer and relayed.
 *
 *   review run --repo O/N --pr N --base SHA --head SHA     prepare  -> NEEDS_AGENT (agents[] verbatim)
 *   review run --collect --review-run-id ID [...]          collect  -> NEEDS_AGENT again | pass | named block
 *   review run --mode remote [--pr N]                      informational read of a phase PR's review
 *
 * A `DISPATCH`, `PENDING`, `TRIAGE` or `ADJUDICATE` answer is a hand-off to the model
 * (`NEEDS_AGENT`). `DONE` is read for one thing only: `reviewStatus.localPhase`. Only
 * `LOCAL_REVIEW_COMPLETE` passes; any other, a missing or an unparseable status is a named block
 * carrying the report path, and it is REFUSED so a caller that ignores the data cannot read it
 * as a pass (Constitution Rules 5 and 7). `RUN_INVALIDATED` (the head moved or the PR is not
 * open) is REFUSED. A runner that cannot be run or read is UNAVAILABLE, never an empty review.
 *
 * `--mode remote` never runs the loop. It reads the recorded state of a stacked phase PR and
 * reports it. It is informational by construction: it always answers OK, so it can neither
 * refuse nor block a closure; anything it cannot recognise is `REVIEW_PENDING`.
 */

const fs = require('fs');
const path = require('path');

const { runJsonCli } = require('../cli-json');
const { git } = require('../git');
const { engineError, isResult, needsAgent, refused, unavailable } = require('../result');
const { deriveStatus } = require('../../pr-review-status');
const { readState, statePath } = require('../../pr-review-state');

const RUNNER_CLI = path.join(__dirname, '..', '..', 'review-run-cli.js');

/** The three statuses `deriveStatus` can answer; anything else is not recognised. */
const KNOWN_STATUSES = Object.freeze(['REVIEW_COMPLETE', 'REVIEW_PENDING', 'REVIEW_BLOCKED']);

/** The shared payload keys the runner understands from this verb's flags. */
const MAX_PAYLOAD_FILE_BYTES = 1024 * 1024;

function invalid(code, message) {
  return engineError('INVALID_INPUT', code, message);
}

/** A JSON file the caller wrote for `triage` or `adjudications`: bounded, parsed, never repaired. */
function readPayloadFile(file, label) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_PAYLOAD_FILE_BYTES) {
      throw invalid('PAYLOAD_FILE_REFUSED', `${label} file must be a regular file under ${MAX_PAYLOAD_FILE_BYTES} bytes`);
    }
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.status) throw err;
    throw invalid('PAYLOAD_FILE_UNREADABLE', `${label} file cannot be read: ${err.code || err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw invalid('INVALID_JSON', `${label} file is not valid JSON: ${err.message}`);
  }
}

function missing(...names) {
  return invalid('MISSING_INPUT', `${names.map(name => `--${name}`).join(', ')} required`);
}

/** The collect command a hand-off tells the model to run next. */
function collectNext(call, reviewRunId, extraArgs = []) {
  const runId = call.globals && call.globals.runId;
  return {
    calls: [
      {
        args: [
          ...(runId ? ['--run-id', runId] : []),
          'review', 'run', '--collect', '--review-run-id', reviewRunId, ...extraArgs,
        ],
        verb: 'review run',
      },
    ],
    verb: 'review run',
  };
}

/**
 * Turn the runner's own answer into the engine result that says the same thing. Nothing here
 * decides a review: it maps statuses to statuses and passes the runner's data through.
 */
function relay(call, answer, { requestedHead } = {}) {
  if (answer.exitCode !== 0 && !answer.json) {
    return unavailable(
      'REVIEW_RUNNER_UNAVAILABLE',
      `review-run-cli produced no JSON answer (exit ${answer.exitCode})${answer.stderr ? `: ${answer.stderr.trim()}` : ''}`
    );
  }
  const json = answer.json;
  if (!json) {
    return unavailable('REVIEW_RUNNER_UNREADABLE', 'review-run-cli printed something that is not a JSON object');
  }

  if (json.ok !== true) {
    const reason = typeof json.reason === 'string' ? json.reason : null;
    const message = String(json.error || json.reason || json.status || 'the review runner refused the request');
    if (json.status === 'RUN_FAILED' && reason === 'invalid-input') {
      return { ...refused('RUN_FAILED', message, json), status: 'INVALID_INPUT' };
    }
    if (json.status === 'RUN_FAILED' && ['head-unreadable', 'pr-unreadable', 'refs-unavailable', 'run-unreadable'].includes(reason)) {
      return unavailable(`RUN_FAILED_${reason.toUpperCase().replace(/-/g, '_')}`, message, json);
    }
    // RUN_INVALIDATED (the head moved or the PR is not open), NEEDS_FULL_MODE and every other
    // RUN_FAILED are the runner declining: surfaced as REFUSED with its own answer as details.
    return refused(typeof json.status === 'string' ? json.status : 'RUN_FAILED', message, json);
  }

  switch (json.status) {
    case 'DISPATCH': {
      if (requestedHead && String(json.headSha) !== requestedHead) {
        return refused(
          'HEAD_MISMATCH',
          `the review runner prepared head ${json.headSha}, not the requested ${requestedHead}; nothing was dispatched`,
          { prepared: json.headSha, requested: requestedHead, reviewRunId: json.runId }
        );
      }
      return handoff(call, json);
    }
    case 'PENDING':
    case 'TRIAGE':
    case 'ADJUDICATE':
      if (json.status === 'ADJUDICATE' && !Array.isArray(json.adjudicate)) break;
      return handoff(call, json);
    case 'DONE':
      return finish(call, json);
    default:
  }
  return unavailable(
    'REVIEW_RUNNER_UNRECOGNISED',
    `review-run-cli answered ok with status '${json.status}', which this verb does not know`,
    json
  );
}

/** A runner answer that needs the model: the agents verbatim, or a request for a decision. */
function handoff(call, json) {
  const { agents, next: _runnerNext, ok: _ok, status, ...rest } = json;
  const data = {
    agents: Array.isArray(agents) ? agents : [],
    baseHead: json.headSha === undefined ? null : json.headSha,
    reviewRunId: json.runId,
    runner: { ...rest, status },
    runnerStatus: status,
  };
  const extra = [];
  if (status === 'TRIAGE') extra.push('--triage-file', '<file with {"additionalCandidates": [...]}>');
  if (status === 'ADJUDICATE') extra.push('--adjudications-file', '<file with [{id, disposition, reason}]>');
  return needsAgent(data, collectNext(call, json.runId, extra));
}

/** The only place a review is read as a pass or a block, and it reads the runner's own status. */
function finish(call, json) {
  const reportPath =
    typeof json.statePath === 'string' ? path.relative(call.projectRoot, json.statePath) || json.statePath : null;
  const status = json.reviewStatus;
  const phase = status && typeof status === 'object' ? status.localPhase : undefined;
  if (phase === 'LOCAL_REVIEW_COMPLETE') {
    return {
      REPORT_PATH: reportPath,
      REVIEW_RUN_ID: json.runId,
      RUNNER: json,
      VERDICT: 'PASS',
    };
  }
  const name = typeof phase === 'string' && phase.length > 0 ? phase : 'STATUS_MISSING';
  return refused(
    'REVIEW_BLOCKED',
    `the local review ended ${name}, not LOCAL_REVIEW_COMPLETE; see ${reportPath || 'the runner answer'}`,
    {
      block: name,
      reasons: status && Array.isArray(status.reasons) ? status.reasons : [],
      reportPath,
      reviewRunId: json.runId,
      reviewStatus: status === undefined ? null : status,
    }
  );
}

function runnerCall(call, cliPath, command, payload) {
  return runJsonCli(cliPath, [command], {
    cwd: call.projectRoot,
    env: call.env,
    input: `${JSON.stringify(payload)}\n`,
  });
}

function prepare(call, cliPath) {
  const input = call.input;
  for (const [name, value] of [['repo', input.repo], ['pr', input.pr], ['base', input.base], ['head', input.head]]) {
    if (value === undefined) throw missing(name);
  }
  const payload = {
    baseSha: input.base,
    ...(input['dry-run'] ? { dryRun: true } : {}),
    ...(input['last-reviewed-sha'] ? { lastReviewedSha: input['last-reviewed-sha'] } : {}),
    pr: input.pr,
    ...(input['remediation-sha'] && input['remediation-sha'].length > 0
      ? { remediationShas: input['remediation-sha'] }
      : {}),
    repo: input.repo,
    repoRoot: call.projectRoot,
    ...(input['skip-precheck'] ? { skipPrecheck: true } : {}),
  };
  return relay(call, runnerCall(call, cliPath, 'prepare', payload), { requestedHead: input.head });
}

function collect(call, cliPath) {
  const input = call.input;
  if (input['review-run-id'] === undefined) throw missing('review-run-id');
  const payload = { repoRoot: call.projectRoot, runId: input['review-run-id'] };
  if (input['triage-file']) payload.triage = readPayloadFile(input['triage-file'], 'triage');
  if (input['adjudications-file']) {
    payload.adjudications = readPayloadFile(input['adjudications-file'], 'adjudications');
  }
  return relay(call, runnerCall(call, cliPath, 'collect', payload));
}

/** The informational read of a stacked phase PR's recorded review. Always OK. */
function remote(call) {
  const input = call.input;
  const report = { INFORMATIONAL: true, MODE: 'remote', PR: input.pr === undefined ? null : input.pr };
  const pending = reasons => ({
    ...report,
    NEXT: null,
    REASONS: reasons,
    REMOTE_PHASE: null,
    REPORT_PATH: null,
    STATUS: 'REVIEW_PENDING',
  });
  if (input.pr === undefined) return pending(['no pull request was created for this phase']);

  let head = input.head;
  if (!head) {
    const out = git(call, ['rev-parse', 'HEAD']);
    if (isResult(out)) return pending([`the head could not be read: ${out.message}`]);
    head = out.trim();
  }
  const reportPath = statePath(input.pr, call.projectRoot);
  const relPath = path.relative(call.projectRoot, reportPath);
  const withPath = answer => ({ ...answer, REPORT_PATH: relPath });
  // `readState` only catches a malformed file; a directory at the report path, a permission
  // error or a vanished file throws. The remote read is informational and must answer OK
  // whatever it finds, so any read failure is a pending review with the reason named.
  let read;
  try {
    read = readState(reportPath, head, { cwd: call.projectRoot });
  } catch (err) {
    return withPath(
      pending([`the recorded review of PR ${input.pr} is unreadable: ${err.code || err.message}`])
    );
  }
  if (!read || read.ok !== true) {
    return withPath(pending([`the recorded review of PR ${input.pr} is unreadable: ${(read && read.reason) || 'no answer'}`]));
  }
  if (!read.exists) return withPath(pending([`no review has been recorded for PR ${input.pr}`]));
  if (read.discarded || !read.state) {
    return withPath(pending([`the recorded review of PR ${input.pr} was made for a different head`]));
  }
  let derived;
  try {
    derived = deriveStatus(read.state);
  } catch (err) {
    return withPath(pending([`the recorded review of PR ${input.pr} could not be read: ${err.message}`]));
  }
  if (!derived || !KNOWN_STATUSES.includes(derived.status)) {
    return withPath(pending(['the recorded review has a status this engine does not recognise']));
  }
  return withPath({
    ...report,
    NEXT: derived.next === undefined ? null : derived.next,
    REASONS: Array.isArray(derived.reasons) ? derived.reasons.map(String) : [],
    REMOTE_PHASE: derived.remotePhase === undefined ? null : derived.remotePhase,
    STATUS: derived.status,
  });
}

/**
 * @param {{cliPath?: string}} [options] `cliPath` replaces the runner executable (tests only)
 * @returns {object} the verb spec
 */
function createSpec({ cliPath = RUNNER_CLI } = {}) {
  return {
    exitCodes: [0, 1, 2, 3, 5],
    group: 'review',
    handler(call) {
      const input = call.input;
      if (input.mode === 'remote') return remote(call);
      return input.collect ? collect(call, cliPath) : prepare(call, cliPath);
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        'adjudications-file': { 'x-path': true, type: 'string' },
        base: { type: 'string' },
        collect: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        head: { type: 'string' },
        'last-reviewed-sha': { type: 'string' },
        mode: { enum: ['local', 'remote'], type: 'string' },
        pr: { minimum: 1, type: 'integer' },
        'remediation-sha': { items: { type: 'string' }, type: 'array' },
        repo: { type: 'string' },
        'review-run-id': { type: 'string' },
        'skip-precheck': { type: 'boolean' },
        'triage-file': { 'x-path': true, type: 'string' },
      },
      type: 'object',
    },
    name: 'run',
    outputSchema: {
      additionalProperties: true,
      properties: {
        INFORMATIONAL: { type: 'boolean' },
        MODE: { enum: ['remote'], type: 'string' },
        NEXT: { type: ['string', 'null'] },
        PR: { type: ['integer', 'null'] },
        REASONS: { items: { type: 'string' }, type: 'array' },
        REMOTE_PHASE: { type: ['string', 'null'] },
        REPORT_PATH: { type: ['string', 'null'] },
        REVIEW_RUN_ID: { type: 'string' },
        RUNNER: { type: 'object' },
        STATUS: { enum: KNOWN_STATUSES.slice(), type: 'string' },
        VERDICT: { enum: ['PASS'], type: 'string' },
        agents: { items: { type: 'object' }, type: 'array' },
        baseHead: { type: ['string', 'null'] },
        reviewRunId: { type: 'string' },
        runner: { type: 'object' },
        runnerStatus: { enum: ['DISPATCH', 'PENDING', 'TRIAGE', 'ADJUDICATE'], type: 'string' },
      },
      required: [],
      type: 'object',
    },
    // The runner writes its run directory and state report under `.ensemble/pr-review/`.
    policyKeys: [],
    sideEffect: 'write',
    summary: 'drive one local review round through review-run-cli (prepare, collect), or read a phase review',
  };
}

module.exports = { createSpec, spec: createSpec() };
