'use strict';

/**
 * TRD-016 (TRD-2026-d571763f): the roles a hand-off can name.
 *
 * A role is the contract between the engine and one kind of model work: the brief the engine
 * writes for the agent, the result the agent writes back, and the precondition the engine
 * re-derives from live state before it accepts that result. Both schemas are
 * `additionalProperties: false`, so a field nobody declared is a refusal rather than data the
 * engine might one day trust (Constitution Rule 6).
 *
 * Review criteria, fix strategies and tone are deliberately absent: they stay in skills and
 * prompts, never in the engine (Constitution Rule 8).
 *
 * A step id is `<role>` or `<role>--<label>`; the role is read off the step id, never off the
 * result file, because the file is exactly what is being checked.
 */

const { isClosed, readIssues } = require('./tracker');
const { isResult, refused } = require('./result');
const { currentBranch, git, gitProbe, remoteDefaultBranch } = require('./git');

const SHA = { pattern: '^[0-9a-f]{7,64}$', type: 'string' };
const TEXT = { maxLength: 20000, minLength: 1, type: 'string' };
const STEP = { pattern: '^[a-z][a-z0-9-]*(--[A-Za-z0-9_-]+)?$', type: 'string' };

/** Fields every brief and result repeats, so the engine can bind a file to its manifest. */
const bindingProperties = role => ({
  head: SHA,
  role: { const: role, type: 'string' },
  step: STEP,
});

function schema(role, properties, required) {
  return {
    additionalProperties: false,
    properties: { ...bindingProperties(role), ...properties },
    required: ['head', 'role', 'step', ...required].sort(),
    type: 'object',
  };
}

/**
 * What the engine dispatched is the `brief` it wrote, not what the result says. Every
 * precondition below reads the dispatched facts from the brief and checks them against live
 * state; a result field is only ever compared to the brief, never used as the thing checked.
 *
 * `bound` names the result fields that must equal the brief's, so a result cannot swap the
 * base a reviewer saw or the branch a PR is for.
 */

/**
 * The dispatched beads, all of them, must be closed in the tracker right now when the agent
 * says it finished. A `done` that names none, fewer or other beads than dispatched is a result
 * for a different job.
 */
function builderWavePrecondition(call, result, brief) {
  const dispatched = [...brief.beads].sort();
  const reported = [...result.beads].sort();
  const stray = reported.filter(id => !dispatched.includes(id));
  if (stray.length > 0 || (result.status === 'done' && reported.join('\n') !== dispatched.join('\n'))) {
    return refused(
      'BINDING_MISMATCH',
      `builder-wave result names beads [${reported.join(', ')}] but [${dispatched.join(', ')}] were dispatched`,
      { dispatched, reported }
    );
  }
  if (brief.delegation) {
    const outcome = require('./builder-wave').checkWave(call, result, brief);
    if (outcome) return outcome;
  }
  if (result.status === 'blocked') return null;
  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const byId = new Map(listed.issues.map(issue => [String(issue && issue.id), issue]));
  const open = dispatched.filter(id => !byId.has(id) || !isClosed(byId.get(id)));
  if (open.length === 0) return null;
  return refused(
    'PRECONDITION_NOT_MET',
    `builder-wave result claims done but the tracker does not show ${open.join(', ')} closed`,
    { beads: open }
  );
}

/**
 * The dispatched base (from the brief) must be a strict ancestor of the live HEAD: there is a
 * diff to have reviewed. Ancestry is read as `merge-base == base`, not from `merge-base
 * --is-ancestor`'s exit status, so a git that cannot run stays UNAVAILABLE.
 */
function reviewerPrecondition(call, result, brief) {
  if (result.base !== brief.base) {
    return refused('BINDING_MISMATCH', `reviewer result is for base ${result.base}, but ${brief.base} was dispatched`, {
      dispatched: brief.base,
      reported: result.base,
    });
  }
  const live = git(call, ['rev-parse', 'HEAD']);
  if (isResult(live)) return live;
  // Exit 1 from these two is the answer "no such commit" / "no common ancestor"; anything else
  // that goes wrong is a git outage and is passed through untouched.
  const resolved = gitProbe(call, ['rev-parse', '--verify', '--quiet', `${brief.base}^{commit}`]);
  if (isResult(resolved)) return resolved;
  if (resolved.exit === 1) {
    return refused('PRECONDITION_NOT_MET', `reviewer base ${brief.base} is not a commit in this repository`, {
      base: brief.base,
    });
  }
  const base = resolved.stdout.trim();
  const common = gitProbe(call, ['merge-base', base, live.trim()]);
  if (isResult(common)) return common;
  if (common.exit === 1 || common.stdout.trim() !== base || base === live.trim()) {
    return refused(
      'PRECONDITION_NOT_MET',
      `reviewer base ${brief.base} is not a strict ancestor of the live HEAD ${live.trim()}, so there is no diff to have reviewed`,
      { base, head: live.trim() }
    );
  }
  return null;
}

/** PR prose is for the dispatched feature branch, still checked out, and not the base branch. */
function prProsePrecondition(call, result, brief) {
  const branch = currentBranch(call);
  if (isResult(branch)) return branch;
  const base = remoteDefaultBranch(call);
  if (branch === '' || branch === base || branch !== brief.branch) {
    return refused(
      'PRECONDITION_NOT_MET',
      `pr-prose was dispatched for '${brief.branch}'; HEAD is ${branch === '' ? 'detached' : `on '${branch}'`}`,
      { base, branch, dispatched: brief.branch }
    );
  }
  return null;
}

const ROLES = Object.freeze({
  'builder-wave': {
    briefSchema: schema(
      'builder-wave',
      {
        beads: { items: { minLength: 1, type: 'string' }, minItems: 1, type: 'array' },
        delegation: {
          additionalProperties: false,
          properties: {
            retry: { enum: [0, 1], type: 'integer' },
            rootEpicId: { minLength: 1, type: 'string' },
            trd: { minLength: 1, type: 'string' },
          },
          required: ['retry', 'rootEpicId', 'trd'],
          type: 'object',
        },
        instructions: TEXT,
      },
      ['beads', 'instructions']
    ),
    deadlineSeconds: 7200,
    description: 'run /ensemble:beads-build for the listed beads',
    precondition: builderWavePrecondition,
    resultSchema: schema(
      'builder-wave',
      {
        beads: { items: { minLength: 1, type: 'string' }, type: 'array' },
        bead_counts: {
          additionalProperties: false,
          properties: {
            closed: { minimum: 0, type: 'integer' },
            open: { minimum: 0, type: 'integer' },
            total: { minimum: 0, type: 'integer' },
          },
          required: ['closed', 'open', 'total'],
          type: 'object',
        },
        branch_state: TEXT,
        ending_head: SHA,
        exit_code: { minimum: 0, type: 'integer' },
        last_task_closed: { type: ['string', 'null'] },
        output: { maxLength: 20000, type: 'string' },
        terminal_state: { enum: ['complete', 'blocked'], type: 'string' },
        status: { enum: ['done', 'blocked'], type: 'string' },
        summary: TEXT,
      },
      ['beads', 'status', 'summary']
    ),
  },
  'pr-prose': {
    briefSchema: schema('pr-prose', { base: SHA, branch: { minLength: 1, type: 'string' } }, ['base', 'branch']),
    deadlineSeconds: 900,
    description: 'write the Risk and How-to-revert text of a pull request',
    precondition: prProsePrecondition,
    resultSchema: schema('pr-prose', { howToRevert: TEXT, risk: TEXT }, ['howToRevert', 'risk']),
  },
  reviewer: {
    briefSchema: schema('reviewer', { base: SHA, prId: { minLength: 1, type: 'string' } }, ['base', 'prId']),
    deadlineSeconds: 1800,
    description: 'review one round of a diff and report findings',
    precondition: reviewerPrecondition,
    resultSchema: schema(
      'reviewer',
      {
        base: SHA,
        findings: {
          items: {
            additionalProperties: false,
            properties: { file: TEXT, line: { minimum: 1, type: 'integer' }, summary: TEXT },
            required: ['file', 'summary'],
            type: 'object',
          },
          type: 'array',
        },
        verdict: { enum: ['pass', 'findings'], type: 'string' },
      },
      ['base', 'findings', 'verdict']
    ),
  },
});

/**
 * @param {string} step `<role>` or `<role>--<label>`
 * @returns {string|null} the role the step names, when it is a registered one
 */
function roleOfStep(step) {
  if (typeof step !== 'string') return null;
  const role = step.split('--')[0];
  return Object.prototype.hasOwnProperty.call(ROLES, role) ? role : null;
}

/** @returns {object[]} the roles as `--describe` publishes them: schemas, never functions */
function describeRoles() {
  return Object.keys(ROLES)
    .sort()
    .map(name => ({
      briefSchema: ROLES[name].briefSchema,
      description: ROLES[name].description,
      name,
      resultSchema: ROLES[name].resultSchema,
    }));
}

module.exports = { ROLES, describeRoles, roleOfStep };
