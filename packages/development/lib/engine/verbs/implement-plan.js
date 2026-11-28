'use strict';

/**
 * TRD-020 (TRD-2026-d571763f): `ensemble implement plan <trd>` -- the ordered step graph of one
 * TRD run, as data.
 *
 * Pure: the TRD file, its saved PR plan and the flags in, the graph out. It never reads the
 * tracker or the working tree's state, so two calls with the same inputs print the same bytes.
 * What is DONE is `implement next`'s question, and it answers it from live state; the plan only
 * says what the steps are, what each needs and what each produces.
 */

const { buildPlan, PLAN_INPUT } = require('../plan');
const { savedPlan } = require('../pr-plan');
const { isResult, refused } = require('../result');
const { readParsedTrd, requireTrd, slugOf } = require('../trd-source');

/**
 * The model `buildPlan` needs, from the TRD and its saved choices.
 * @param {object} call the dispatcher's call object
 * @returns {{trdPath: string, slug: string, phases: object[], prPlan: object, parsed: object,
 *   plan: object}|object} the model, or a tagged engine result
 */
function loadModel(call) {
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const parsed = readParsedTrd(call, trd.path);
  if (isResult(parsed)) return parsed;
  const prPlan = savedPlan(call, trd.path);
  if (isResult(prPlan)) return prPlan;

  const slug = String(parsed.slug || slugOf(trd.path));
  const phases = (Array.isArray(parsed.phases) ? parsed.phases : []).map(phase => ({
    n: Number(phase.n),
    taskIds: Array.isArray(phase.taskIds) ? phase.taskIds.map(String) : [],
    title: String(phase.title || ''),
  }));
  const flags = { execute: call.input.execute === true, planOnly: call.input['plan-only'] === true };
  return {
    parsed,
    phases,
    plan: buildPlan({ flags, phases, prPlan, slug, trdPath: trd.path }),
    prPlan,
    slug,
    trdPath: trd.path,
  };
}

function handler(call) {
  const flags = call.input;
  if (flags.execute === true && flags['plan-only'] === true) {
    return refused('PLAN_EXECUTE_EXCLUSIVE', 'ERROR: --plan-only and --execute are mutually exclusive.');
  }
  const model = loadModel(call);
  if (isResult(model)) return model;
  const { plan } = model;
  return {
    SLUG: plan.slug,
    STACKED: plan.stacked,
    STEPS: plan.steps,
    STOP_AFTER: plan.stopAfter,
    TRD_FILE_PATH: plan.trd,
  };
}

const STEP_SCHEMA = {
  additionalProperties: false,
  properties: {
    args: { type: 'object' },
    id: { type: 'string' },
    kind: { enum: ['engine', 'agent', 'choice'], type: 'string' },
    preconditions: { items: { type: 'string' }, type: 'array' },
    produces: { items: { type: 'string' }, type: 'array' },
    verb: { type: 'string' },
  },
  required: ['args', 'id', 'kind', 'preconditions', 'produces', 'verb'],
  type: 'object',
};

const spec = {
  exitCodes: [0, 1, 2, 5],
  group: 'implement',
  handler,
  inputSchema: PLAN_INPUT,
  name: 'plan',
  outputSchema: {
    additionalProperties: false,
    properties: {
      SLUG: { type: 'string' },
      STACKED: { type: 'boolean' },
      STEPS: { items: STEP_SCHEMA, type: 'array' },
      STOP_AFTER: { type: ['string', 'null'] },
      TRD_FILE_PATH: { type: 'string' },
    },
    required: ['SLUG', 'STACKED', 'STEPS', 'STOP_AFTER', 'TRD_FILE_PATH'],
    type: 'object',
  },
  policyKeys: [],
  sideEffect: 'read',
  summary: 'the ordered step graph of one TRD run: id, verb, kind, preconditions and what each step produces',
};

module.exports = { loadModel, spec };
