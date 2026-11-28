'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');
const { buildRegistry } = require('../lib/ensemble-cli');
const { makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');

const TRD = 'docs/TRD/widget-engine.md';
const TASK = id => `[trd:widget-engine:task:${id}]`;
let fx;
let snapshot;
let epic;
let toolchain;
let trackerAdapter;

jest.setTimeout(120000);

function run(argv) {
  return runMain(['--run-id', 'r1', '--non-interactive', ...argv],
    makeCtx({ cwd: fx.root, env: fx.env, registry: buildRegistry() }));
}

function delegate(flags = []) {
  return run(['implement', 'delegate', TRD, '--root-epic-id', epic, ...flags]);
}

function task(id) {
  return fx.tracker.issues().find(issue => issue.title.startsWith(TASK(id))).id;
}

function git(args) {
  return execFileSync('git', args, { cwd: fx.root, env: fx.env, encoding: 'utf8' }).trim();
}

function buildCommit() {
  fs.appendFileSync(path.join(fx.root, 'wave-work.txt'), 'built a task\n');
  git(['add', '--', 'wave-work.txt']);
  git(['commit', '--quiet', '-m', 'build wave']);
  return git(['rev-parse', 'HEAD']);
}

/** A native work-graph adapter: readiness is an independent tool response, not inferred by the test. */
function graphWithout(ids = []) {
  const items = fx.tracker.issues().filter(issue => !ids.includes(issue.id)).map(issue => ({ id: issue.id }));
  const dataFile = path.join(fx.binDir, 'graph-data.json');
  fs.writeFileSync(dataFile, JSON.stringify({ items }));
  const bin = path.join(fx.binDir, 'fixture-graph');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(dataFile)}, 'utf8'));\n`, { mode: 0o755 });
  const dir = path.join(fx.root, 'packages', 'fixture-pkg', 'skills', 'fixture-graph');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# fixture graph\n');
  fs.writeFileSync(path.join(dir, 'adapter.yaml'), yaml.dump({
    adapter: 'fixture-graph', version: '1.0.0', categories: ['work-graph'], contract: { 'work-graph': '2.0' },
    binaries: ['fixture-graph'], allowlist: [{ bin: 'fixture-graph', sub: ['ready', 'plan'] }],
    env: [], health: [], detect: [], capabilities: {
      'work-graph.ready': { run: ['fixture-graph', 'ready'] },
      'work-graph.plan': { run: ['fixture-graph', 'plan'] },
    },
  }));
  fs.writeFileSync(path.join(fx.root, '.ensemble', 'toolchain.yaml'), `${toolchain}\nwork-graph: fixture-graph\n`);
}

function manifest() {
  const out = delegate();
  expect(out.envelope.status).toBe('NEEDS_AGENT');
  const agent = out.envelope.data.agents[0];
  const brief = JSON.parse(fs.readFileSync(path.join(fx.root, agent.briefPath), 'utf8'));
  return { agent, brief };
}

function accept({ agent, brief }, extra = {}) {
  const result = {
    beads: brief.beads,
    bead_counts: { closed: 0, open: brief.beads.length, total: brief.beads.length },
    branch_state: 'feature branch, clean',
    exit_code: 0,
    ending_head: git(['rev-parse', 'HEAD']),
    head: brief.head,
    last_task_closed: null,
    role: 'builder-wave',
    status: 'blocked',
    step: agent.step,
    summary: 'builder summary',
    terminal_state: 'blocked',
    ...extra,
  };
  fs.writeFileSync(path.join(fx.root, agent.outPath), JSON.stringify(result));
  return run(['implement', 'accept', '--step', agent.step, '--result-file', agent.outPath]);
}

beforeAll(() => {
  fx = makeRepo({ files: {
    'README.md': 'widget\n',
    [TRD]: fixtureTrd({ synth: false }).replace('status: In Progress',
      'status: In Progress\nteam:\n  roles:\n    - name: builder\n      agents: [fixture-builder]\n      owns: [implementation]'),
    'packages/fixture/agents/fixture-builder.yaml': 'metadata:\n  name: fixture-builder\n',
  }, init: false });
  fx.tracker = createTrackerStub(fx.root);
  initRepo(fx);
  expect(run(['tool', 'preflight', '--require', 'tracker.list', '--require', 'tracker.create', '--run-id', 'r1']).exitCode).toBe(0);
  const built = run(['implement', 'scaffold', TRD]);
  if (built.exitCode !== 0) throw new Error(JSON.stringify(built.envelope));
  epic = fx.tracker.issues().find(issue => issue.title.startsWith('[trd:widget-engine]')).id;
  snapshot = fx.tracker.snapshot();
  toolchain = fs.readFileSync(path.join(fx.root, '.ensemble', 'toolchain.yaml'), 'utf8');
  trackerAdapter = fs.readFileSync(path.join(fx.tracker.adapterDir, 'adapter.yaml'), 'utf8');
});

beforeEach(() => {
  fx.tracker.restore(snapshot);
  fs.writeFileSync(path.join(fx.tracker.adapterDir, 'adapter.yaml'), trackerAdapter);
  fs.writeFileSync(path.join(fx.root, '.ensemble', 'toolchain.yaml'), toolchain);
  fs.rmSync(path.join(fx.root, '.ensemble', 'state', 'engine'), { recursive: true, force: true });
});

test('requires the epic before reading or writing the tracker', () => {
  const before = fx.tracker.snapshot();
  const out = run(['implement', 'delegate', TRD]);
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.message).toBe('Cannot delegate to beads-build — ROOT_EPIC_ID missing.');
  expect(fx.tracker.snapshot()).toBe(before);
});

test('backfills scoped labels and returns both exact invocations with sorted flags', () => {
  const state = JSON.parse(fx.tracker.snapshot());
  for (const issue of state.issues) issue.labels = [];
  state.issues.push({ id: 'foreign', title: '[trd:other:task:TRD-001] Other', status: 'open', labels: [] });
  fx.tracker.restore(JSON.stringify(state));
  const out = delegate(['--max-parallel', '3']);
  expect(out.exitCode).toBe(3);
  expect(out.envelope.status).toBe('NEEDS_AGENT');
  const agent = out.envelope.data.agents[0];
  expect(agent.role).toBe('builder-wave');
  const brief = JSON.parse(fs.readFileSync(path.join(fx.root, agent.briefPath), 'utf8'));
  const roles = `'{"builder":{"agents":["fixture-builder"],"owns":["implementation"]}}'`;
  const flags = `--defer-completion --label widget-engine --max-parallel 3 --team-roles ${roles} --trd ${TRD}`;
  expect(brief.instructions.split('\n')[0]).toBe(`/ensemble:beads-build ${epic} ${flags}`);
  expect(brief.instructions.split('\n')[1]).toBe(`Without slash dispatch, invoke the skill: ensemble-beads-build --defer-completion --epic ${epic} ${flags.slice('--defer-completion '.length)}`);
  expect(agent.prompt).toContain('ensemble-beads-build --defer-completion --epic');
  for (const issue of fx.tracker.issues().filter(issue => issue.id !== 'foreign')) {
    expect(issue.labels).toContain('widget-engine');
  }
  expect(fx.tracker.issues().find(issue => issue.id === 'foreign').labels).toEqual([]);
});

test('lists every scoped bead lacking references and refuses before dispatch', () => {
  fx.tracker.setDescription(task('TRD-001'), 'missing references');
  fx.tracker.setDescription(task('TRD-003'), 'also missing');
  const out = delegate();
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.details.missing).toEqual([
    `${task('TRD-001')}: missing ## References`, `${task('TRD-003')}: missing ## References`,
  ]);
  expect(fs.existsSync(path.join(fx.root, '.ensemble', 'state', 'engine'))).toBe(false);
});

test('lists unresolved root reference entries', () => {
  fx.tracker.setDescription(epic, '## References\n- TRD: docs/TRD/missing.md\n');
  const out = delegate();
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.details.missing.length).toBeGreaterThan(0);
  for (const missing of out.envelope.error.details.missing) expect(out.envelope.error.message).toContain(missing);
});

test('resolves present task reference blocks and lists every invalid entry before dispatch', () => {
  const first = task('TRD-001');
  const later = task('TRD-003');
  fx.tracker.setDescription(first, `## References\nTRD: ${TRD}\nTRD Task: ${TRD}#trd-999\nPRD: docs/PRD/missing.md\n`);
  fx.tracker.setDescription(later, '## References\nTRD: docs/TRD/missing.md\n');
  const out = delegate();
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.details.missing).toEqual(expect.arrayContaining([
    `${first}: TRD task trd-999 not found in ${TRD}`,
    `${first}: PRD file docs/PRD/missing.md cannot be read: ENOENT`,
    `${later}: TRD file docs/TRD/missing.md cannot be read: ENOENT`,
  ]));
  for (const missing of out.envelope.error.details.missing) expect(out.envelope.error.message).toContain(missing);
  expect(fs.existsSync(path.join(fx.root, '.ensemble', 'state', 'engine'))).toBe(false);
});

test('an unavailable tracker.show is not reported as missing references', () => {
  const adapter = yaml.load(trackerAdapter);
  delete adapter.capabilities['tracker.show'];
  fs.writeFileSync(path.join(fx.tracker.adapterDir, 'adapter.yaml'), yaml.dump(adapter));
  const out = delegate();
  expect(out.envelope.status).toBe('UNAVAILABLE');
  expect(out.envelope.error.code).toBe('REFERENCES_UNREADABLE');
  expect(fs.existsSync(path.join(fx.root, '.ensemble', 'state', 'engine'))).toBe(false);
});

test('the tracker.show allowlist refusal is returned unchanged', () => {
  const adapter = yaml.load(trackerAdapter);
  adapter.allowlist[0].sub = adapter.allowlist[0].sub.filter(sub => sub !== 'show');
  fs.writeFileSync(path.join(fx.tracker.adapterDir, 'adapter.yaml'), yaml.dump(adapter));
  const out = delegate();
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.code).toBe('NOT_ALLOWED');
  expect(out.envelope.error.message).not.toContain('missing ## References');
  expect(fs.existsSync(path.join(fx.root, '.ensemble', 'state', 'engine'))).toBe(false);
});

test('a non-zero exit is a Debug Loop refusal and records no accepted result', () => {
  const m = manifest();
  const out = accept(m, { exit_code: 2, output: 'compiler failed' });
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.message).toContain('Debug Loop');
  expect(out.envelope.error.details.DEBUG_LOOP[0]).toMatchObject({ exit_code: 2, output: 'compiler failed' });
  expect(fs.existsSync(path.join(fx.root, '.ensemble', 'state', 'engine', 'r1', 'accepted'))).toBe(false);
});

test('zero exit records the summary after the tracker proves tasks closed', () => {
  const m = manifest();
  for (const id of m.brief.beads) fx.tracker.setStatus(id, 'closed');
  const counts = { closed: m.brief.beads.length, open: 0, total: m.brief.beads.length };
  const out = accept(m, { status: 'done', terminal_state: 'complete', bead_counts: counts, last_task_closed: task('TRD-003') });
  expect(out.envelope.status).toBe('OK');
  const record = JSON.parse(fs.readFileSync(path.join(fx.root, out.envelope.data.RECORD_PATH), 'utf8'));
  expect(record.result).toMatchObject({ bead_counts: counts, branch_state: 'feature branch, clean', last_task_closed: task('TRD-003') });
});

test('a committing builder wave binds its ending head and records closed tasks', () => {
  const m = manifest();
  const endingHead = buildCommit();
  for (const id of m.brief.beads) fx.tracker.setStatus(id, 'closed');
  const counts = { closed: m.brief.beads.length, open: 0, total: m.brief.beads.length };
  const out = accept(m, { status: 'done', terminal_state: 'complete', bead_counts: counts, last_task_closed: task('TRD-003') });
  expect(out.envelope.status).toBe('OK');
  const record = JSON.parse(fs.readFileSync(path.join(fx.root, out.envelope.data.RECORD_PATH), 'utf8'));
  expect(record).toMatchObject({ head: endingHead, result: {
    head: m.brief.head, ending_head: endingHead, bead_counts: counts, last_task_closed: task('TRD-003'),
  } });
});

test('a delegated summary requires an explicit ending head', () => {
  const out = accept(manifest(), { ending_head: undefined });
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.code).toBe('BUILDER_SUMMARY_MISSING');
});

test('a committing wave with an ending head different from live HEAD is stale', () => {
  const m = manifest();
  buildCommit();
  const out = accept(m, { ending_head: m.brief.head });
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.code).toBe('STALE_RESULT');
});

test('a committing wave cannot replace its immutable dispatch head', () => {
  const m = manifest();
  const endingHead = buildCommit();
  const out = accept(m, { head: endingHead });
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.code).toBe('STALE_RESULT');
});

test.each(['unrelated', 'rewritten'])('%s history cannot be accepted as builder completion', mode => {
  buildCommit();
  const m = manifest();
  const branch = git(['branch', '--show-current']);
  const parents = mode === 'rewritten' ? ['-p', git(['rev-parse', `${m.brief.head}^`])] : [];
  const other = git(['commit-tree', `${m.brief.head}^{tree}`, ...parents, '-m', mode]);
  try {
    git(['switch', '--detach', other]);
    const out = accept(m);
    expect(out.envelope.status).toBe('REFUSED');
    expect(out.envelope.error.code).toBe('STALE_RESULT');
    expect(out.envelope.error.message).toContain('ancestor');
  } finally {
    git(['switch', branch]);
  }
});

test('a non-zero committing wave still reaches the Debug Loop', () => {
  const m = manifest();
  buildCommit();
  const out = accept(m, { exit_code: 2, output: 'failed after checkpoint' });
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.code).toBe('BUILDER_FAILED');
  expect(out.envelope.error.details.DEBUG_LOOP[0].output).toBe('failed after checkpoint');
});

test('a blocked committing wave can retry from its verified ending head', () => {
  const m = manifest();
  const endingHead = buildCommit();
  graphWithout();
  const out = accept(m);
  expect(out.envelope.status).toBe('NEEDS_AGENT');
  const agent = out.envelope.data.agents[0];
  const brief = JSON.parse(fs.readFileSync(path.join(fx.root, agent.briefPath), 'utf8'));
  expect(brief.head).toBe(endingHead);
  expect(brief.delegation.retry).toBe(1);
});

test('done with open tasks cannot be accepted', () => {
  const m = manifest();
  buildCommit();
  const out = accept(m, { status: 'done', terminal_state: 'complete' });
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.code).toBe('PRECONDITION_NOT_MET');
});

test('a current-phase task absent from ready and plan refuses with the phase', () => {
  const m = manifest();
  const id = task('TRD-001');
  graphWithout([id]);
  const out = accept(m);
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.code).toBe('EXECUTION_BLOCKED');
  expect(out.envelope.error.message).toContain('current-phase 1');
  expect(out.envelope.error.details.tasks).toContain('TRD-001');
});

test('a present but unclosed task requests one retry, then refuses another', () => {
  graphWithout();
  const out = accept(manifest());
  expect(out.envelope.status).toBe('NEEDS_AGENT');
  const agent = out.envelope.data.agents[0];
  expect(agent.step).toBe('builder-wave--wave-retry');
  const brief = JSON.parse(fs.readFileSync(path.join(fx.root, agent.briefPath), 'utf8'));
  expect(brief.delegation.retry).toBe(1);
  const again = accept({ agent, brief });
  expect(again.envelope.status).toBe('REFUSED');
  expect(again.envelope.error.code).toBe('WAVE_RETRY_EXHAUSTED');
});

test('later-phase blockers and static traceability do not refuse the current phase', () => {
  const m = manifest();
  const later = task('TRD-003');
  graphWithout([later]);
  const out = accept(m);
  expect(out.envelope.status).toBe('NEEDS_AGENT');
});

test('the lowest unfinished phase advances from live closed task state', () => {
  const m = manifest();
  for (const id of ['TRD-001', 'TRD-001-TEST', 'TRD-002', 'TRD-002-TEST']) fx.tracker.setStatus(task(id), 'closed');
  const later = task('TRD-003');
  graphWithout([later]);
  const out = accept(m);
  expect(out.envelope.status).toBe('REFUSED');
  expect(out.envelope.error.details.current_phase).toBe(2);
});

test('a work-graph outage is unavailable, never an empty ready list', () => {
  const m = manifest();
  const config = path.join(fx.root, '.ensemble', 'toolchain.yaml');
  const original = fs.readFileSync(config, 'utf8');
  try {
    fs.writeFileSync(config, `${original}\nwork-graph: fixture-tracker\n`);
    const out = accept(m);
    expect(out.envelope.status).toBe('UNAVAILABLE');
    expect(out.envelope.error.code).toBe('WORK_GRAPH_UNREADABLE');
  } finally { fs.writeFileSync(config, original); }
});
