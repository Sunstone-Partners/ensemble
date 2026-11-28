'use strict';

/**
 * TRD-020 (TRD-2026-d571763f): `ensemble implement next <trd>` -- the one question the model asks
 * in a loop: what do I do now?
 *
 * Every call re-derives the answer from live state. In order:
 *
 *  1. the five derivation steps -- `args`, `env`, `resume`, `team`, `branch` (read form) -- run
 *     in process and come back as `CONTEXT`. They leave no trace in the tracker, so they are
 *     evaluated on every call instead of being surfaced as outstanding work. A derivation that
 *     refuses, asks a choice or finds a tool missing is returned unchanged: that is how an
 *     unpersisted choice (the PR backend, the branching strategy) is asked again on every call
 *     until the caller supplies it. Nothing is remembered between calls.
 *  2. the step graph of `implement plan`, against the live tracker, git and TRD file.
 *  3. the first step that is not already done and whose preconditions hold becomes `ACTION`.
 *
 * `STATE` is `STEP` (do `ACTION`), `COMPLETE` (every step is evident in state) or `EXIT` (the
 * run asked to stop: `--plan-only` after the scaffold). A step whose precondition is unmet while
 * an earlier one claims to be done is `REFUSED` naming the precondition. The envelope's `next`
 * field stays empty: it belongs to `NEEDS_AGENT` alone, so `ACTION` is data.
 *
 * Nothing here reads the audit ledger or the run directory (Constitution Rule 4).
 */

const { decide, FORWARDED, PLAN_INPUT, readLiveState } = require('../plan');
const { isResult, refused } = require('../result');
const { validateInput } = require('../validate');
const { flipCheckboxes, readReview } = require('./implement-close');
const { loadModel } = require('./implement-plan');
const { gitProbe, remoteDefaultBranch } = require('../git');
const { loadPolicy } = require('../policy');

/** Drop keys whose value is undefined, so an absent flag stays absent. */
function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * Run another registered verb in process, through the same schema check argv input gets.
 * @returns {object} the verb's tagged result or plain data
 */
function invoke(call, group, name, input) {
  const spec = call.registry.get(group, name);
  const checked = validateInput(defined(input), spec.inputSchema);
  return spec.handler({ ...call, input: checked, verb: `${group} ${name}` });
}

/**
 * The derivation steps, each handed only the flags it declares.
 * @returns {{context: object}|object} the results by name, or the first non-data result
 */
function derive(call, trdPath, { closed }) {
  const f = call.input;
  const planOnly = f['plan-only'] === true ? true : undefined;
  const execute = f.execute === true ? true : undefined;
  const calls = [
    ['args', 'args', {
      branch: f.branch,
      execute,
      foreman: f.foreman === true ? true : undefined,
      'max-parallel': f['max-parallel'],
      operands: [trdPath],
      plan: planOnly,
      strategy: f.strategy,
      'use-current-branch': f['use-current-branch'] === true ? true : undefined,
    }],
    ['env', 'env', { execute, plan: planOnly, 'pr-backend': f['pr-backend'] }],
    // A closed epic is past every start-of-run gate: `resume` would call it a fresh run and
    // refuse the dirty tree the closure and the checkbox sync legitimately leave behind.
    ['resume', 'resume', { execute, strategy: f.strategy, trd: trdPath }],
    ['team', 'team', { builder: f.builder, trd: trdPath }],
    ['branch', 'branch', {
      branch: f.branch,
      execute,
      plan: planOnly,
      strategy: f.strategy,
      trd: trdPath,
      'use-current-branch': f['use-current-branch'] === true ? true : undefined,
    }],
  ];
  const context = {};
  for (const [key, name, input] of calls) {
    if (closed && (key === 'resume' || key === 'branch')) {
      context[key] = null;
      continue;
    }
    const answer = invoke(call, 'implement', name, input);
    if (isResult(answer)) return answer;
    context[key] = answer;
  }
  return { context };
}

/**
 * The arguments a step is called with: its own, plus the caller's flags the verb declares, plus
 * the values only live state knows (the epic id, the parallelism the preflight settled on).
 */
function actionArgs(call, step, state, context) {
  const args = { ...step.args };
  const target = step.verb.split(' ');
  const spec = call.registry.get(target[0], target[1]);
  const declared = spec ? spec.inputSchema.properties || {} : {};
  for (const flag of FORWARDED) {
    if (call.input[flag] !== undefined && declared[flag] !== undefined && args[flag] === undefined) {
      args[flag] = call.input[flag];
    }
  }
  if (step.id === 'review-completion') {
    // The whole branch against the default branch: the merge base and the HEAD, both read from git.
    const baseRef = remoteDefaultBranch(call);
    const head = gitProbe(call, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (isResult(head)) return head;
    const base = gitProbe(call, ['merge-base', `refs/remotes/origin/${baseRef}`, 'HEAD']);
    if (isResult(base)) return base;
    if (head.exit !== 0 || base.exit !== 0) {
      return refused(
        'REVIEW_BASE_UNRESOLVED',
        `the completion review needs the merge base of HEAD and origin/${baseRef}, and git could not resolve it`,
        { baseRef }
      );
    }
    args.base = base.stdout.trim();
    args['base-ref'] = baseRef;
    args.head = head.stdout.trim();
  }
  if (step.id === 'delegate') {
    args['root-epic-id'] = state.epic.id;
    if (args['max-parallel'] === undefined && Number.isInteger(context.args.MAX_PARALLEL)) {
      args['max-parallel'] = context.args.MAX_PARALLEL;
    }
  }
  return args;
}

function handler(call) {
  const f = call.input;
  if (f.execute === true && f['plan-only'] === true) {
    return refused('PLAN_EXECUTE_EXCLUSIVE', 'ERROR: --plan-only and --execute are mutually exclusive.');
  }
  const model = loadModel(call);
  if (isResult(model)) return model;

  // The derivation results arrive after the live state is read (the state says whether the epic
  // is already closed, which decides which derivations still make sense), so the one fact the
  // state needs from them is asked for lazily.
  const context = {};
  const policy = loadPolicy({ projectRoot: call.projectRoot });
  const state = readLiveState(call, {
    flipCheckboxes,
    phases: model.phases,
    prBackend: () => context.env && context.env.PR_BACKEND,
    prPlan: model.prPlan,
    readReview,
    slug: model.slug,
    strategyInformational: () => {
      const strategy = context.resume && context.resume.STRATEGY;
      return Boolean(policy.strategy_gate && policy.strategy_gate[strategy] === 'informational');
    },
    trdPath: model.trdPath,
  });
  if (isResult(state)) return state;

  const derived = derive(call, model.trdPath, { closed: state.epicClosed });
  if (isResult(derived)) return derived;
  Object.assign(context, derived.context);

  const base = { CONTEXT: context, TRD_FILE_PATH: model.trdPath, TRD_SLUG: model.slug };
  if (context.args.EARLY_EXIT) {
    return { ...base, ACTION: null, COMPLETED: [], STATE: 'EXIT' };
  }

  const decision = decide(model.plan, state, { branch: context.branch, prPlan: model.prPlan });
  if (isResult(decision)) return decision;

  if (decision.unmet) {
    const { precondition, step } = decision.unmet;
    return refused(
      'PRECONDITION_UNMET',
      `step '${step.id}' is next but its precondition ${precondition} does not hold in the current tracker, git and TRD state`,
      { completed: decision.done, precondition, step: step.id }
    );
  }
  if (decision.step === null) {
    // `--plan-only` runs the plan up to the scaffold and stops there: that is EXIT, not COMPLETE.
    const state = model.plan.stopAfter !== null ? 'EXIT' : 'COMPLETE';
    return { ...base, ACTION: null, COMPLETED: decision.done, STATE: state };
  }

  const step = decision.step;
  const built = actionArgs(call, step, state, context);
  if (isResult(built)) return built;
  return {
    ...base,
    ACTION: {
      args: built,
      id: step.id,
      kind: step.kind,
      preconditions: step.preconditions,
      produces: step.produces,
      verb: step.verb,
    },
    COMPLETED: decision.done,
    STATE: 'STEP',
  };
}

const spec = {
  exitCodes: [0, 1, 2, 4, 5],
  group: 'implement',
  handler,
  inputSchema: PLAN_INPUT,
  name: 'next',
  outputSchema: {
    additionalProperties: false,
    properties: {
      ACTION: { type: ['object', 'null'] },
      COMPLETED: { items: { type: 'string' }, type: 'array' },
      CONTEXT: { type: 'object' },
      STATE: { enum: ['STEP', 'COMPLETE', 'EXIT'], type: 'string' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
    },
    required: ['ACTION', 'COMPLETED', 'CONTEXT', 'STATE', 'TRD_FILE_PATH', 'TRD_SLUG'],
    type: 'object',
  },
  policyKeys: ['strategy_gate'],
  sideEffect: 'read',
  summary: 'the first step of the run that is not already done in live state, with the derivation results as context',
};

module.exports = { spec };
