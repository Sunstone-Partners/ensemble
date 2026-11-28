'use strict';

const { isResult, refused, unavailable } = require('./result');
const { callCapability, classify, isClosed, isTaskLevel, readIssues, scopeBeads } = require('./tracker');
const { readParsedTrd, slugOf } = require('./trd-source');

/** Re-read readiness from both supported work-graph views; a failed read is never an empty list. */
function readyIds(call) {
  const ids = new Set();
  for (const capability of ['work-graph.ready', 'work-graph.plan']) {
    const answer = classify(callCapability(call, capability), capability);
    if (answer.kind === 'gate') return answer.result;
    if (answer.kind !== 'ok') return unavailable('WORK_GRAPH_UNREADABLE', answer.message);
    let data = answer.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    if (!data || !Array.isArray(data.items)) {
      return unavailable('WORK_GRAPH_UNREADABLE', `${capability} returned no items list`);
    }
    for (const item of data.items) {
      const id = typeof item === 'string' ? item : item && item.id;
      if (typeof id !== 'string' || id.trim() === '') {
        return unavailable('WORK_GRAPH_UNREADABLE', `${capability} returned an item without an id`);
      }
      ids.add(id);
    }
  }
  return ids;
}

/** The generic hand-off owns binding and persistence; this hook owns the beads-build outcome. */
function checkWave(call, result, brief) {
  for (const key of ['exit_code', 'terminal_state', 'bead_counts', 'branch_state', 'last_task_closed']) {
    if (result[key] === undefined) return refused('BUILDER_SUMMARY_MISSING', `builder-wave summary is missing ${key}`);
  }
  if (result.exit_code !== 0) {
    const debug = { exit_code: result.exit_code, output: result.output || result.summary, step: result.step };
    return refused('BUILDER_FAILED', `Debug Loop: beads-build exited ${result.exit_code}\n${debug.output}`, { DEBUG_LOOP: [debug] });
  }
  if ((result.terminal_state === 'blocked') !== (result.status === 'blocked')) {
    return refused('BUILDER_SUMMARY_INCONSISTENT', 'builder-wave status and terminal_state disagree');
  }
  if (result.terminal_state !== 'blocked') return null;

  const parsed = readParsedTrd(call, brief.delegation.trd);
  if (isResult(parsed)) return parsed;
  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, slugOf(brief.delegation.trd)).filter(bead => isTaskLevel(bead.kind));
  const phases = [...parsed.phases].sort((a, b) => Number(a.n) - Number(b.n));
  // The live tracker determines completion. Traceability edges and later phases do not gate this wave.
  const current = phases.find(phase => phase.taskIds.some(id => !beads.some(bead => bead.taskId === id && isClosed(bead))));
  if (!current) return null;
  const openTasks = current.taskIds.filter(id => !beads.some(bead => bead.taskId === id && isClosed(bead)));
  const ready = readyIds(call);
  if (isResult(ready)) return ready;
  const absent = openTasks.filter(id => !beads.some(bead => bead.taskId === id && !isClosed(bead) && ready.has(bead.id)));
  if (absent.length > 0) {
    return refused('EXECUTION_BLOCKED', `EXECUTION BLOCKED: current-phase ${current.n} has open blockers — resolve or run /ensemble:refine-beads.`, {
      current_phase: Number(current.n), tasks: absent,
    });
  }
  if (brief.delegation.retry === 1) {
    return refused('WAVE_RETRY_EXHAUSTED', `beads-build phase ${current.n} remains unclosed after one retry`, {
      current_phase: Number(current.n), tasks: openTasks,
    });
  }
  return require('./verbs/implement-delegate').dispatch(call, {
    beads: brief.beads,
    delegation: { ...brief.delegation, retry: 1 },
    instructions: `${brief.instructions}\nRetry once: current_phase=${current.n}; its ready tasks remain unclosed.`,
  });
}

module.exports = { checkWave };
