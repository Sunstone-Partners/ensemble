'use strict';

/**
 * TRD-020 (TRD-2026-d571763f): the planner. Two halves that must never be confused.
 *
 * `buildPlan` is PURE: the step graph of one TRD, a function of the TRD's phases, its PR plan and
 * the flags -- no tracker, no git, no clock. `implement plan` prints it, and the same inputs give
 * the same bytes.
 *
 * `decide` reads LIVE state and names the first step that is not already done and whose
 * preconditions hold. Completion is judged from the epic and bead states, git and the TRD file
 * only (Constitution Rule 4). The audit ledger and the run directory are never opened here.
 *
 * Evidence each step's completion rests on (and nothing else):
 *   checkout            the branch the plan wants is the branch that is checked out (only asked
 *                       while no epic exists: afterwards the verbs' own branch checks stand)
 *   scaffold            an epic titled `[trd:<slug>]` exists in the tracker
 *   delegate            every task-level bead of the TRD is closed
 *   gate-<N>            the phase story is closed, or carries a `Quality gate result: PASS`
 *                       comment (stacked mode keeps the story open; an informational strategy
 *                       also accepts FAIL, which is the gate's own recorded verdict there)
 *   pr-<N>, pr-completion
 *                       `host.change-request-list` shows an open pull request whose head is the
 *                       planned branch. A push is NOT evidence (an Azure hand-off, a failed
 *                       create and a manual push all push and open nothing); with the `manual`
 *                       backend, or a host that cannot answer, the answer is UNAVAILABLE.
 *   review-completion   the recorded whole-branch review for this HEAD is LOCAL_REVIEW_COMPLETE
 *                       (the same reading `implement close` makes, `.ensemble/pr-review/`)
 *   close               the epic is closed
 *   sync-checkboxes     no closed task's checkbox is still unchecked in the TRD file
 */

const fs = require('fs');
const path = require('path');

const { gateAction, completionAction } = require('./pr-plan');
const { isResult, unavailable } = require('./result');
const { callCapability, classify, isClosed, isTaskLevel, readComments, readIssues, scopeBeads } = require('./tracker');
const { parseTitlePrefix } = require('../bead-refs');
const { STRATEGIES } = require('./policy');

/** The comment prefix the gate records on a phase story (`messages.qualityGateComment`). */
const GATE_PASS = 'Quality gate result: PASS';
const GATE_FAIL = 'Quality gate result: FAIL';

/** Flags that `next` forwards to a step's verb when that verb declares them. */
const FORWARDED = ['strategy', 'pr-backend', 'framework', 'builder', 'max-parallel'];

/** The flags `plan` and `next` share: what they need to see the same run. */
const PLAN_INPUT = {
  additionalProperties: false,
  properties: {
    branch: { pattern: '^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$', type: 'string' },
    builder: { pattern: '^[a-z][a-z0-9-]{0,63}$', type: 'string' },
    execute: { type: 'boolean' },
    foreman: { type: 'boolean' },
    framework: { type: 'string' },
    'max-parallel': { minimum: 1, type: 'integer' },
    'plan-only': { type: 'boolean' },
    'pr-backend': { enum: ['gh', 'ado', 'manual'], type: 'string' },
    strategy: { enum: [...STRATEGIES], type: 'string' },
    trd: { type: 'string', 'x-operand': true },
    'use-current-branch': { type: 'boolean' },
  },
  type: 'object',
};

function step(id, verb, kind, args, preconditions, produces) {
  return { args, id, kind, preconditions, produces, verb };
}

/**
 * The step graph.
 *
 * @param {{trdPath: string, slug: string, phases: {n: number, title?: string}[],
 *   prPlan: {stacked: boolean, actions: object[]}, flags?: {execute?: boolean, planOnly?: boolean}}} model
 * @returns {{slug: string, stacked: boolean, steps: object[], stopAfter: string|null, trd: string}}
 */
function buildPlan(model) {
  const { trdPath, slug, phases, prPlan } = model;
  const flags = model.flags || {};
  const trd = { trd: trdPath };
  const steps = [];

  steps.push(
    step('checkout', 'implement branch', 'engine', { ...trd, apply: true }, ['TRD_VALID'], [
      'the feature branch is checked out',
      'branch choices saved in the TRD frontmatter',
    ])
  );
  if (flags.execute !== true) {
    steps.push(
      step('scaffold', 'implement scaffold', 'engine', trd, ['TRD_VALID'], [
        'epic [trd:<slug>]',
        'one story per phase and one bead per task',
        'dependency edges',
      ])
    );
  }
  if (flags.planOnly !== true) {
    steps.push(
      step('delegate', 'implement delegate', 'agent', trd, ['EPIC_OPEN'], [
        'every task bead closed by the builder wave',
      ])
    );
    const stackedPrs = [];
    for (const phase of [...phases].sort((a, b) => a.n - b.n)) {
      steps.push(
        step(`gate-${phase.n}`, 'implement gate', 'engine', trd, ['EPIC_OPEN', `PHASE_${phase.n}_TASKS_CLOSED`], [
          `quality-gate result recorded on the story of phase ${phase.n}`,
        ])
      );
      const action = gateAction(prPlan, phase.n);
      if (action && action.createPr === true) {
        stackedPrs.push(
          step(`pr-${phase.n}`, 'implement pr', 'agent', { ...trd, phase: phase.n }, [`GATE_${phase.n}_RECORDED`], [
            `phase ${phase.n} branch pushed and its pull request opened`,
          ])
        );
      }
    }
    // A stacked phase's pull request follows its own gate; keep each directly after its gate.
    for (const pr of stackedPrs) {
      const at = steps.findIndex(s => s.id === `gate-${pr.args.phase}`);
      steps.splice(at + 1, 0, pr);
    }

    const completion = completionAction(prPlan);
    const reviewSkippable = prPlan.stacked === true && completion !== null && completion.createPr === false;
    if (!reviewSkippable) {
      steps.push(
        step('review-completion', 'review run', 'agent', {}, ['ALL_GATES_RECORDED'], [
          'whole-branch review recorded as LOCAL_REVIEW_COMPLETE for this HEAD',
        ])
      );
    }
    steps.push(
      step('close', 'implement close', 'engine', trd, ['ALL_GATES_RECORDED', 'ALL_TASKS_CLOSED'], [
        'completion verification passed',
        'epic closed with a reason and the HEAD sha',
      ])
    );
    steps.push(
      step('sync-checkboxes', 'implement sync-checkboxes', 'engine', trd, ['EPIC_CLOSED'], [
        'TRD checkboxes match the closed beads',
      ])
    );
    if (completion !== null && completion.createPr === true) {
      steps.push(
        step('pr-completion', 'implement pr', 'agent', { ...trd, completion: true }, ['EPIC_CLOSED'], [
          'completion branch pushed and its pull request opened',
        ])
      );
    }
  }

  return {
    slug,
    stacked: prPlan.stacked === true,
    steps,
    stopAfter: flags.planOnly === true ? 'scaffold' : null,
    trd: trdPath,
  };
}

// ------------------------------------------------------------------------------ live state

/**
 * Read everything `decide` needs, once. Anything that costs a tracker or git call is lazy, so a
 * call only pays for the steps it actually reaches.
 *
 * @param {object} call the dispatcher's call object
 * @param {{trdPath: string, slug: string, phases: object[], prPlan: object, prBackend: Function, strategyInformational: Function,
 *   readReview: Function, flipCheckboxes: Function}} model
 * @returns {object} the live state, or a tagged engine result
 */
function readLiveState(call, model) {
  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, model.slug);
  const epics = beads.filter(b => b.kind === 'epic');
  const epic = epics.find(b => !isClosed(b)) || epics[0] || null;
  const tasks = beads.filter(b => isTaskLevel(b.kind));
  const stories = new Map();
  for (const bead of beads) {
    if (bead.kind !== 'story') continue;
    const info = parseTitlePrefix(bead.title);
    if (info && Number.isInteger(info.phaseN)) stories.set(info.phaseN, bead);
  }
  const phaseTaskIds = new Map(model.phases.map(p => [p.n, p.taskIds || []]));
  const cache = new Map();
  const once = (key, compute) => {
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  };

  const state = {
    epic,
    epicClosed: epic !== null && isClosed(epic),
    phaseTasksClosed(n) {
      const ids = phaseTaskIds.get(n) || [];
      return ids.every(id => {
        const mine = tasks.filter(t => t.taskId === id);
        return mine.length > 0 && mine.every(isClosed);
      });
    },
    allTasksClosed: tasks.length > 0 && tasks.every(isClosed),
    /** @returns {boolean|object} whether the phase's gate result is on record, or a tagged result */
    gateRecorded(n) {
      return once(`gate-${n}`, () => {
        const story = stories.get(n);
        if (!story) return false;
        if (isClosed(story)) return true;
        if (!state.phaseTasksClosed(n)) return false;
        const comments = readComments(call, story.id);
        if (isResult(comments)) return comments;
        if (comments.kind === 'gate') return comments.result;
        if (!Array.isArray(comments.texts)) {
          return unavailable(
            'GATE_EVIDENCE_UNREADABLE',
            `the gate comments of phase ${n} could not be read: ${comments.message || comments.kind || 'no answer'}`
          );
        }
        return comments.texts.some(
          text =>
            text.startsWith(GATE_PASS) ||
            (model.strategyInformational() && text.startsWith(GATE_FAIL))
        );
      });
    },
    /** @returns {boolean|object} whether the whole-branch review is complete for this HEAD */
    reviewComplete() {
      return once('review', () => {
        const review = model.readReview(call, `${model.slug}-completion`);
        if (isResult(review)) return review;
        return review.STATE === 'complete';
      });
    },
    /**
     * Whether an open pull request from `branch` exists on the host: a positive answer from
     * `host.change-request-list`, never inferred from a push (an Azure hand-off, a failed create
     * and a manual push all leave a pushed branch and no pull request). A backend that leaves
     * nothing to read, and a host that cannot answer, are UNAVAILABLE -- never "no PR yet".
     * @returns {boolean|object} a boolean, or a tagged engine result
     */
    prOpen(branch) {
      return once(`pr-${branch}`, () => {
        if (typeof branch !== 'string' || branch === '') return false;
        const backend = model.prBackend();
        if (backend === 'manual') {
          return unavailable(
            'PR_EVIDENCE_UNSUPPORTED',
            `the PR backend is 'manual': a pull request opened by hand leaves nothing the engine can read, so it cannot say whether '${branch}' has one`,
            { backend, branch }
          );
        }
        const answer = classify(callCapability(call, 'host.change-request-list'), 'host.change-request-list');
        if (answer.kind === 'gate') return answer.result;
        if (answer.kind !== 'ok') {
          return unavailable(
            'PR_EVIDENCE_UNAVAILABLE',
            `host.change-request-list could not say whether '${branch}' has an open pull request: ${answer.message || answer.kind}`,
            { backend, branch }
          );
        }
        let payload = answer.data;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            payload = null;
          }
        }
        const items = Array.isArray(payload) ? payload : payload && Array.isArray(payload.items) ? payload.items : null;
        if (items === null) {
          return unavailable('PR_EVIDENCE_UNAVAILABLE', 'host.change-request-list output has no pull request list', { backend, branch });
        }
        const bare = ref => String(ref == null ? '' : ref).replace(/^refs\/heads\//, '');
        return items.some(item => item && bare(item.headBranch) === branch);
      });
    },
    /** @returns {boolean} whether every closed task's checkbox is checked in the TRD file */
    checkboxesSynced() {
      return once('checkboxes', () => {
        const text = fs.readFileSync(path.resolve(call.projectRoot, model.trdPath), 'utf8');
        const closedIds = [...new Set(tasks.filter(t => isClosed(t) && t.taskId).map(t => t.taskId))];
        return model.flipCheckboxes(text, closedIds).changed.length === 0;
      });
    },
  };
  return state;
}

/**
 * @param {string} name a precondition name from the plan
 * @param {object} state `readLiveState`
 * @param {object} plan `buildPlan`
 * @returns {boolean|object} whether it holds, or a tagged result from a failed read
 */
function holds(name, state, plan) {
  if (name === 'TRD_VALID') return true;
  if (name === 'EPIC_OPEN') return state.epic !== null && !state.epicClosed;
  if (name === 'EPIC_CLOSED') return state.epicClosed;
  if (name === 'ALL_TASKS_CLOSED') return state.allTasksClosed;
  let match = /^PHASE_(\d+)_TASKS_CLOSED$/.exec(name);
  if (match) return state.phaseTasksClosed(Number(match[1]));
  match = /^GATE_(\d+)_RECORDED$/.exec(name);
  if (match) return state.gateRecorded(Number(match[1]));
  if (name === 'ALL_GATES_RECORDED') {
    for (const s of plan.steps.filter(x => x.id.startsWith('gate-'))) {
      const done = state.gateRecorded(Number(s.id.slice(5)));
      if (done !== true) return done;
    }
    return true;
  }
  throw new Error(`plan: unknown precondition '${name}'`);
}

/**
 * Whether a step's completion is already evident in live state.
 * @returns {boolean|object} a boolean, or a tagged result from a failed read
 */
function isDone(s, state, plan, context) {
  switch (s.id) {
    case 'checkout':
      return state.epic !== null || (context.branch && context.branch.BRANCH_ACTION === 'stay');
    case 'scaffold':
      return state.epic !== null;
    case 'delegate':
      return state.allTasksClosed;
    case 'review-completion':
      return state.reviewComplete();
    case 'close':
      return state.epicClosed;
    case 'sync-checkboxes':
      return state.checkboxesSynced();
    case 'pr-completion': {
      const action = completionAction(context.prPlan);
      return state.prOpen(action && action.branch);
    }
    default: {
      if (s.id.startsWith('gate-')) return state.gateRecorded(Number(s.id.slice(5)));
      if (s.id.startsWith('pr-')) {
        const action = gateAction(context.prPlan, Number(s.id.slice(3)));
        return state.prOpen(action && action.branch);
      }
      throw new Error(`plan: unknown step '${s.id}'`);
    }
  }
}

/**
 * The first step that is not done and whose preconditions hold.
 *
 * @param {object} plan `buildPlan`
 * @param {object} state `readLiveState`
 * @param {object} context `{branch, prPlan}` -- the derivation results `next` already evaluated
 * @returns {{done: string[], step: object|null, unmet: {step: object, precondition: string}|null}|object}
 *   the decision, or a tagged result from a failed read
 */
function decide(plan, state, context) {
  const done = [];
  const closeAt = plan.steps.findIndex(s => s.id === 'close');
  for (let index = 0; index < plan.steps.length; index++) {
    const s = plan.steps[index];
    // Once the epic is closed, everything up to the closure is history: its evidence (open
    // stories, a review state for an older HEAD) no longer describes anything outstanding.
    const finished =
      state.epicClosed && closeAt !== -1 && index <= closeAt ? true : isDone(s, state, plan, context);
    if (isResult(finished)) return finished;
    if (finished === true) {
      done.push(s.id);
      continue;
    }
    for (const name of s.preconditions) {
      const ok = holds(name, state, plan);
      if (isResult(ok)) return ok;
      if (ok !== true) return { done, step: null, unmet: { precondition: name, step: s } };
    }
    return { done, step: s, unmet: null };
  }
  return { done, step: null, unmet: null };
}

module.exports = { FORWARDED, PLAN_INPUT, GATE_FAIL, GATE_PASS, buildPlan, decide, holds, isDone, readLiveState };
