'use strict';

const { handOff } = require('../handoff');
const { isResult, refused } = require('../result');
const { requireTrd, slugOf } = require('../trd-source');
const { isClosed, isTaskLevel, readIssues, scopeBeads } = require('../tracker');
const { checkReferences, labelBeads } = require('./implement-bead-health');

/** Quote each argument as a shell word; the returned commands are instructions, never executed here. */
function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : `'${text.replace(/'/g, `'"'"'`)}'`;
}

function dispatch(call, { beads, delegation, instructions }) {
  return handOff(call, {
    agents: [{
      brief: { beads, delegation, instructions },
      name: delegation.retry === 0 ? 'wave' : 'wave-retry',
      prompt: `${instructions}\nWrite the builder-wave result to the manifest's outPath. Copy head, role and step from the brief. Report exit_code, terminal_state, bead_counts, branch_state and last_task_closed; put command output in output.`,
    }],
    role: 'builder-wave',
  });
}

function handler(call) {
  const rootEpicId = call.input['root-epic-id'];
  if (!rootEpicId) return refused('ROOT_EPIC_ID_MISSING', 'Cannot delegate to beads-build — ROOT_EPIC_ID missing.');
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const slug = slugOf(trd.path);
  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, slug);
  if (!beads.some(bead => bead.id === rootEpicId && bead.kind === 'epic')) {
    return refused('ROOT_EPIC_NOT_SCOPED', `ROOT_EPIC_ID '${rootEpicId}' is not the epic of '${slug}'.`);
  }
  const warnings = [];
  const label = labelBeads(call, slug, warnings);
  if (isResult(label)) return label;
  const checked = checkReferences(call, { beads, rootEpicId, trdPath: trd.path, warnings, requireAll: true });
  if (isResult(checked)) return checked;
  const team = require('./implement-team').spec.handler({ ...call, input: {
    trd: trd.path, ...(call.input.builder ? { builder: call.input.builder } : {}),
  } });
  if (isResult(team)) return team;
  const args = require('./implement-args').spec.handler({ ...call, input: {
    operands: [trd.path], ...(call.input['max-parallel'] ? { 'max-parallel': call.input['max-parallel'] } : {}),
  } });
  if (isResult(args)) return args;
  const flags = ['--defer-completion', '--label', quote(slug), '--max-parallel', String(args.MAX_PARALLEL),
    '--team-roles', quote(team.TEAM_ROLES_JSON), '--trd', quote(trd.path)];
  const slash = ['/ensemble:beads-build', quote(rootEpicId), ...flags].join(' ');
  const skill = ['ensemble-beads-build', '--defer-completion', '--epic', quote(rootEpicId), ...flags.slice(1)].join(' ');
  const instructions = `${slash}\nWithout slash dispatch, invoke the skill: ${skill}\n${[...warnings, ...team.WARNINGS, ...args.WARNINGS].join('\n')}`;
  const tasks = beads.filter(bead => isTaskLevel(bead.kind) && !isClosed(bead)).map(bead => bead.id).sort();
  if (tasks.length === 0) return refused('NO_OPEN_TASKS', `No open task beads remain in '${slug}'.`);
  return dispatch(call, {
    beads: tasks,
    delegation: { retry: 0, rootEpicId, trd: trd.path },
    instructions,
  });
}

const spec = {
  exitCodes: [0, 1, 2, 3, 5],
  group: 'implement',
  handler,
  inputSchema: {
    additionalProperties: false,
    properties: {
      builder: { pattern: '^[a-z][a-z0-9-]{0,63}$', type: 'string' },
      'max-parallel': { maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' },
      'root-epic-id': { minLength: 1, type: 'string' },
      trd: { type: 'string', 'x-operand': true },
    },
    type: 'object',
  },
  name: 'delegate',
  outputSchema: { additionalProperties: false, properties: {}, type: 'object' },
  policyKeys: ['max_parallel_default'],
  sideEffect: 'write',
  summary: 'check scoped bead context and hand execution to the beads-build builder wave',
};

module.exports = { dispatch, spec };
