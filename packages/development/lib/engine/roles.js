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
const { currentBranch, git, remoteDefaultBranch } = require('./git');

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
 * Each builder-wave bead must be closed in the tracker right now. The manifest cannot vouch for
 * that; only the tracker can.
 */
function builderWavePrecondition(call, result) {
  if (result.status === 'blocked') return null;
  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const byId = new Map(listed.issues.map(issue => [String(issue && issue.id), issue]));
  const open = result.beads.filter(id => !byId.has(id) || !isClosed(byId.get(id)));
  if (open.length === 0) return null;
  return refused(
    'PRECONDITION_NOT_MET',
    `builder-wave result claims done but the tracker does not show ${open.join(', ')} closed`,
    { beads: open }
  );
}

/**
 * The reviewed base must be a strict ancestor of the live HEAD: there is a diff to have reviewed.
 * Ancestry is read as `merge-base == base`, not from `merge-base --is-ancestor`'s exit status, so
 * a git that cannot run stays UNAVAILABLE instead of reading as "not an ancestor".
 */
function reviewerPrecondition(call, result) {
  const live = git(call, ['rev-parse', 'HEAD']);
  if (isResult(live)) return live;
  const base = git(call, ['rev-parse', '--verify', '--quiet', `${result.base}^{commit}`]);
  if (isResult(base)) {
    return refused('PRECONDITION_NOT_MET', `reviewer base ${result.base} is not a commit in this repository`, {
      base: result.base,
    });
  }
  const mergeBase = git(call, ['merge-base', base.trim(), live.trim()]);
  if (isResult(mergeBase)) return mergeBase;
  if (mergeBase.trim() !== base.trim() || base.trim() === live.trim()) {
    return refused(
      'PRECONDITION_NOT_MET',
      `reviewer base ${result.base} is not a strict ancestor of the live HEAD ${live.trim()}, so there is no diff to have reviewed`,
      { base: base.trim(), head: live.trim() }
    );
  }
  return null;
}

/** PR prose is for a branch that is not the base branch: a PR from the default branch is no PR. */
function prProsePrecondition(call) {
  const branch = currentBranch(call);
  if (isResult(branch)) return branch;
  const base = remoteDefaultBranch(call);
  if (branch === '' || branch === base) {
    return refused(
      'PRECONDITION_NOT_MET',
      `pr-prose needs a feature branch checked out; HEAD is ${branch === '' ? 'detached' : `on '${base}'`}`,
      { base, branch }
    );
  }
  return null;
}

const ROLES = Object.freeze({
  'builder-wave': {
    briefSchema: schema(
      'builder-wave',
      { beads: { items: { minLength: 1, type: 'string' }, minItems: 1, type: 'array' }, instructions: TEXT },
      ['beads', 'instructions']
    ),
    deadlineSeconds: 7200,
    description: 'run /ensemble:beads-build for the listed beads',
    precondition: builderWavePrecondition,
    resultSchema: schema(
      'builder-wave',
      {
        beads: { items: { minLength: 1, type: 'string' }, type: 'array' },
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
