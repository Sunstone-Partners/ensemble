'use strict';

/**
 * TRD-016 (TRD-2026-d571763f): the engine-to-model hand-off protocol.
 *
 * `review-run-cli prepare` already proved the pattern: do every mechanical step, return a
 * manifest of agents to start, and validate what they hand back. This module generalises it
 * for every verb, in two halves:
 *
 * - `handOff` is what a verb returns when a step needs judgement: it writes each agent's brief,
 *   records the base HEAD and answers `NEEDS_AGENT` with the agents and a `next` that names
 *   `implement accept`.
 * - `acceptResult` is that verb. A result file is untrusted input: it must sit under
 *   `.ensemble/state/engine/<runId>/results/`, stay under a size cap, validate against its
 *   role's schema, name the HEAD the work was done against, and meet a precondition the engine
 *   re-derives from live state. A file that fails any of those is refused whole -- never
 *   repaired, never partly applied (Constitution Rules 6 and 7).
 *
 * Nothing here reads the audit ledger to decide anything. The manifest is a convenience for the
 * model; the decision is made from the result file, git and the tracker as they are now.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { sortKeys } = require('./envelope');
const { git } = require('./git');
const { resolveInteractivity } = require('./interactivity');
const { engineError, isResult, needsAgent, needsChoice, refused } = require('./result');
const { ROLES, roleOfStep } = require('./roles');
const { isInside, realpathOfNearestAncestor, validateInput } = require('./validate');
const { ensureStateDir } = require('../toolchain/state-dir');
const { invalidRunIdMessage, isValidRunId } = require('../toolchain/run-id');

/** A result file larger than this is refused unread; a judgement result is a few KiB. */
const MAX_RESULT_BYTES = 256 * 1024;

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** @returns {string} the run id the caller supplied with the global `--run-id` */
function requireRunId(call) {
  const runId = call.globals && call.globals.runId;
  if (!isValidRunId(runId)) {
    throw engineError(
      'INVALID_INPUT',
      'RUN_ID_REQUIRED',
      `a hand-off is keyed by --run-id (from \`ensemble tool preflight\`); ${invalidRunIdMessage(runId)}`
    );
  }
  return runId;
}

/**
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {{run: string, briefs: string, results: string, accepted: string}} absolute directories
 */
function runDirs(projectRoot, runId) {
  const run = path.join(projectRoot, '.ensemble', 'state', 'engine', runId);
  return {
    accepted: path.join(run, 'accepted'),
    briefs: path.join(run, 'briefs'),
    results: path.join(run, 'results'),
    run,
  };
}

function liveHead(call) {
  const out = git(call, ['rev-parse', 'HEAD']);
  if (isResult(out)) return out;
  return out.trim();
}

/**
 * Make `dir` (under `.ensemble/state/engine/<runId>`) and prove it is really inside the project.
 *
 * The check runs BEFORE `mkdir` as well as after: `.ensemble/state/engine` may be a symlink
 * that leads out of the tree, and `mkdir -p` would follow it and create the directory there.
 * Real paths are compared, so a link anywhere along the way is caught.
 *
 * @returns {string} the real directory
 * @throws {Error} `PATH_ESCAPE` when any part of the path resolves outside the project root
 */
function safeStateDir(call, dir) {
  const root = fs.realpathSync(call.projectRoot);
  const stateRoot = path.join(root, '.ensemble', 'state');
  const escape = real =>
    engineError('INVALID_INPUT', 'PATH_ESCAPE', `state directory '${dir}' resolves to '${real}', outside the project`);
  const before = realpathOfNearestAncestor(dir);
  if (!isInside(stateRoot, before)) throw escape(before);
  ensureStateDir(call.projectRoot, dir);
  const real = fs.realpathSync(dir);
  if (!isInside(stateRoot, real)) throw escape(real);
  return real;
}

/**
 * Write `body` to `target` without ever following a link: a fresh randomly named file is
 * created exclusively (`wx` refuses an existing path, link or not) and renamed over the target,
 * which replaces a link at the target instead of writing through it.
 */
function writeFileSafely(target, body) {
  const tmp = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { flag: 'wx' });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** `now` (seconds, injected by the dispatcher) plus the window, as an ISO string. */
function deadlineIso(call, seconds) {
  return new Date((call.now + seconds) * 1000).toISOString();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Hand a step to the model.
 *
 * @param {object} call the dispatcher's call object
 * @param {{role: string, agents: {name: string, label?: string, brief: object, prompt?: string}[]}} request
 *   `brief` carries the role's own fields; the engine adds `head`, `role` and `step`
 * @returns {object} a tagged `NEEDS_AGENT` result, or a tagged refusal when HEAD cannot be read
 * @throws {Error} a plain Error when the verb built an invalid brief: that is an engine bug
 */
function handOff(call, { role, agents }) {
  if (!Object.prototype.hasOwnProperty.call(ROLES, role)) {
    throw new Error(`handOff: unknown role '${role}'`);
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('handOff: a hand-off needs at least one agent');
  }
  const runId = requireRunId(call);
  const head = liveHead(call);
  if (isResult(head)) return head;

  const dirs = runDirs(call.projectRoot, runId);
  safeStateDir(call, dirs.briefs);
  safeStateDir(call, dirs.results);
  const rel = file => path.relative(call.projectRoot, file).split(path.sep).join('/');

  const seen = new Set();
  const manifest = agents.map(agent => {
    if (!AGENT_NAME_RE.test(agent.name) || seen.has(agent.name)) {
      throw new Error(`handOff: agent name '${agent.name}' is invalid or repeated`);
    }
    seen.add(agent.name);
    const step = `${role}--${agent.label || agent.name}`;
    const brief = { ...agent.brief, head, role, step };
    try {
      validateInput(brief, ROLES[role].briefSchema);
    } catch (err) {
      throw new Error(`handOff: brief for ${step} breaks the ${role} brief schema: ${err.message}`);
    }
    const briefFile = path.join(dirs.briefs, `${step}.json`);
    const outFile = path.join(dirs.results, `${step}.json`);
    writeFileSafely(briefFile, `${JSON.stringify(brief, null, 2)}\n`);
    return {
      briefPath: rel(briefFile),
      deadlineAtIso: deadlineIso(call, ROLES[role].deadlineSeconds),
      name: agent.name,
      outPath: rel(outFile),
      prompt:
        agent.prompt ||
        `Read ${rel(briefFile)} and write a JSON result for the ${role} role to ${rel(outFile)}. ` +
          `Use exactly the result schema \`ensemble --describe\` publishes for ${role}; copy head and step from the brief.`,
      role,
      step,
    };
  });

  return needsAgent(
    { agents: manifest, baseHead: head, runId },
    {
      calls: manifest.map(agent => ({
        args: ['--run-id', runId, 'implement', 'accept', '--step', agent.step, '--result-file', agent.outPath],
        verb: 'implement accept',
      })),
      verb: 'implement accept',
    }
  );
}

/** Read at most the cap plus one byte, so an oversized file is never held whole. */
function readCapped(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_RESULT_BYTES + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return read > MAX_RESULT_BYTES ? null : buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The brief the engine wrote for `step`. Missing or invalid means the engine never dispatched
 * this step (or the file was tampered with): REFUSED, never guessed at.
 */
function readBrief(call, dirs, step, role) {
  const file = path.join(dirs.briefs, `${step}.json`);
  let brief;
  try {
    // The brief is read through its real path, which must stay inside the briefs directory.
    const real = fs.realpathSync(file);
    if (!isInside(fs.realpathSync(dirs.briefs), real)) throw new Error('brief resolves outside the briefs directory');
    brief = JSON.parse(fs.readFileSync(real, 'utf8'));
    validateInput(brief, ROLES[role].briefSchema);
  } catch (err) {
    return refused('NO_DISPATCH', `step '${step}' has no valid dispatch brief at ${path.relative(call.projectRoot, file)}`, {
      reason: err.code || err.message,
    });
  }
  if (brief.step !== step || brief.role !== role) {
    return refused('NO_DISPATCH', `the brief at ${path.relative(call.projectRoot, file)} is for a different step`, null);
  }
  return brief;
}

/**
 * Validate and record one result. See the module comment for the contract.
 * @param {object} call the dispatcher's call object
 * @param {{step: string, resultFile: string}} input `resultFile` already contained to the project
 * @returns {object} the acceptance report, or a tagged refusal
 * @throws {Error} an `INVALID_INPUT` engine error for a malformed, oversized or escaped file
 */
function acceptResult(call, { step, resultFile }) {
  const runId = requireRunId(call);
  const role = roleOfStep(step);
  if (!role) {
    throw engineError(
      'INVALID_INPUT',
      'UNKNOWN_STEP',
      `step '${step}' names no registered role; expected <role> or <role>--<label> for one of ${Object.keys(ROLES).join(', ')}`
    );
  }

  // Containment is against the REAL results directory, so a symlink inside it that leads out is
  // an escape too. The project-root check of the input boundary has already run.
  const dirs = runDirs(call.projectRoot, runId);
  const resultsReal = realpathOfNearestAncestor(dirs.results, { rejectDanglingSymlink: false });
  if (!isInside(resultsReal, resultFile) || resultFile === resultsReal) {
    throw engineError(
      'INVALID_INPUT',
      'PATH_ESCAPE',
      `result file '${resultFile}' is outside ${path.relative(call.projectRoot, dirs.results)}`
    );
  }

  let stat;
  try {
    stat = fs.statSync(resultFile);
  } catch (err) {
    throw engineError('INVALID_INPUT', 'RESULT_NOT_FOUND', `result file cannot be read: ${err.code || err.message}`);
  }
  if (!stat.isFile()) {
    throw engineError('INVALID_INPUT', 'RESULT_NOT_FILE', `result file '${resultFile}' is not a regular file`);
  }
  const text = stat.size > MAX_RESULT_BYTES ? null : readCapped(resultFile);
  if (text === null) {
    throw engineError(
      'INVALID_INPUT',
      'RESULT_TOO_LARGE',
      `result file exceeds the ${MAX_RESULT_BYTES} byte limit; refused unparsed`
    );
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw engineError('INVALID_INPUT', 'INVALID_JSON', `result is not valid JSON: ${err.message}`);
  }
  try {
    validateInput(result, ROLES[role].resultSchema);
  } catch (err) {
    throw engineError('INVALID_INPUT', err.code || 'SCHEMA_VIOLATION', err.message.replace(/^input field/, 'result field'));
  }
  if (result.step !== step) {
    throw engineError('INVALID_INPUT', 'STEP_MISMATCH', `result names step '${result.step}', not '${step}'`);
  }

  // The dispatch is the brief the engine wrote when it handed the step out. It is read back
  // only to learn WHAT was dispatched (the head, the base, the beads); whether that is still
  // true is decided below from git and the tracker as they are now. A result with no brief, or
  // one that disagrees with it, answers a job the engine never gave.
  const brief = readBrief(call, dirs, step, role);
  if (isResult(brief)) return brief;
  if (result.head !== brief.head) {
    return refused(
      'STALE_RESULT',
      `result was produced against ${result.head}, but the step was dispatched at ${brief.head}; rerun the step`,
      { dispatchedHead: brief.head, resultHead: result.head }
    );
  }
  const head = liveHead(call);
  if (isResult(head)) return head;
  if (head !== brief.head) {
    return refused(
      'STALE_RESULT',
      `step was dispatched at ${brief.head}, but HEAD is now ${head}; rerun the step`,
      { dispatchedHead: brief.head, head }
    );
  }

  const precondition = ROLES[role].precondition(call, result, brief);
  if (precondition) return precondition;

  const record = { head, result, resultSha256: sha256(text), role, step };
  const target = path.join(dirs.accepted, `${step}.json`);
  const body = `${JSON.stringify(sortKeys(record), null, 2)}\n`;
  // Nothing is created until the directory is proven to be inside the project.
  safeStateDir(call, dirs.accepted);
  let existing = null;
  try {
    const entry = fs.lstatSync(target);
    existing = entry.isFile() ? fs.readFileSync(target, 'utf8') : '';
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing !== null && existing !== body) {
    return refused('ALREADY_ACCEPTED', `step '${step}' already has a different accepted result`, {
      recorded: path.relative(call.projectRoot, target),
    });
  }
  writeFileSafely(target, body);

  return {
    ACCEPTED: true,
    HEAD: head,
    RECORD_PATH: path.relative(call.projectRoot, target).split(path.sep).join('/'),
    RESULT: result,
    RESULT_SHA256: record.resultSha256,
    ROLE: role,
    STEP: step,
  };
}

/**
 * Resolve a decision that would otherwise be a prompt.
 *
 * Interactive callers get `NEEDS_CHOICE` and ask their user. A non-interactive run
 * (`--non-interactive`, `--foreman`, `FOREMAN_TASK_TITLE`) never gets a prompt: it takes the
 * policy value when there is one, and otherwise is refused with the exact flag to pass.
 *
 * @param {object} call the dispatcher's call object
 * @param {{id: string, question: string, flag: string, options: {value: string}[]}} choice
 * @param {{policyValue?: string}} [policy] the policy's answer, when the choice has one
 * @returns {{value: string}|object} the resolved value, or a tagged `NEEDS_CHOICE`/refusal
 */
function resolveChoice(call, choice, { policyValue } = {}) {
  const { interactive } = resolveInteractivity({ env: call.env, globals: call.globals });
  if (interactive) return needsChoice(choice);
  if (policyValue !== undefined && choice.options.some(option => option.value === policyValue)) {
    return { value: policyValue };
  }
  return refused(
    'CHOICE_REQUIRED',
    `${choice.question} A non-interactive run cannot ask: pass ${choice.flag} <${choice.options
      .map(option => option.value)
      .join('|')}>`,
    { flag: choice.flag, id: choice.id, options: choice.options }
  );
}

module.exports = { MAX_RESULT_BYTES, acceptResult, handOff, resolveChoice, runDirs };
