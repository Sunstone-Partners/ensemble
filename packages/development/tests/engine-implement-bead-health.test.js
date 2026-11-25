'use strict';

/**
 * TRD-012-TEST (TRD-2026-d571763f): `ensemble implement bead-health <trd>`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` of `lib/ensemble-cli.js` through
 * the real `buildRegistry()`, against a real git repository whose tracker is the stateful stub
 * of `tests/fixtures/engine/tracker-stub.js`, and whose hierarchy was created by a real
 * `implement scaffold` run. Nothing the verb reports -- the edge diff, the work-graph findings,
 * the reference count, the label count -- is stubbed inside the engine.
 *
 * "The tracker is unchanged" is read off the stub's own state digest, its mutation log and
 * `git status`, never off the verb's own report.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const { buildRegistry } = require('../lib/ensemble-cli');
const MESSAGES = require('../lib/engine/messages');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');

const TRD_PATH = 'docs/TRD/widget-engine.md';
const SLUG = 'widget-engine';
const EPIC = `[trd:${SLUG}]`;
const PHASE_1 = `[trd:${SLUG}:phase:1]`;
const PHASE_2 = `[trd:${SLUG}:phase:2]`;
const TASK = id => `[trd:${SLUG}:task:${id}]`;

jest.setTimeout(600000);

function healthSpec() {
  return buildRegistry().get('implement', 'bead-health');
}

/**
 * A repository whose TRD, tracker adapter and preflight record are real, and whose bead
 * hierarchy was created by a real `implement scaffold` run unless `scaffold: false`.
 *
 * @param {{scaffold?: boolean, trd?: object}} [options] everything else goes to the stub
 * @returns {{binDir: string, env: object, root: string, tracker: object}}
 */
function healthRepo(options = {}) {
  const { scaffold = true, trd = {}, ...stubOptions } = options;
  const fx = makeRepo({
    files: {
      'README.md': 'widget engine\n',
      'package.json': '{"name":"widget-engine","version":"1.0.0"}\n',
      [TRD_PATH]: fixtureTrd(trd),
    },
    init: false,
  });
  fx.tracker = createTrackerStub(fx.root, stubOptions);
  initRepo(fx, {});
  const preflight = runMain(
    ['tool', 'preflight', '--require', 'tracker.list', '--require', 'tracker.create', '--run-id', 'r1'],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
  expect(preflight.exitCode).toBe(0);
  if (scaffold) {
    const built = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'scaffold', TRD_PATH],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(built.exitCode).toBe(0);
  }
  return fx;
}

function run(fx, argv = [], globals = ['--run-id', 'r1', '--non-interactive']) {
  return runMain(
    [...globals, 'implement', 'bead-health', TRD_PATH, ...argv],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
}

/** The plan of record, read from the same `trd-cli` verb the verb itself drives. */
function scaffoldCalls(fx) {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
    { cwd: fx.root, encoding: 'utf8', env: fx.env }
  );
  return JSON.parse(out);
}

/** Bead id by title prefix, as the stub holds them. */
function idsByPrefix(fx) {
  const map = new Map();
  for (const issue of fx.tracker.issues()) {
    const prefix = (String(issue.title).match(/^\s*(\[[^\]]+\])/) || [])[1];
    if (prefix && !map.has(prefix)) map.set(prefix, issue.id);
  }
  return map;
}

function porcelain(fx) {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: fx.root,
    encoding: 'utf8',
    env: fx.env,
  });
}

describe('the live edges are diffed against the plan', () => {
  test('a dropped planned edge is missing and an unplanned one is extra', () => {
    const fx = healthRepo();
    const ids = idsByPrefix(fx);
    const plan = scaffoldCalls(fx);
    // One planned edge removed behind the engine's back, and the legacy inter-phase gate a
    // pre-planner scaffold used to wire seeded in its place.
    fx.tracker.dropEdge(ids.get(PHASE_1), ids.get(TASK('TRD-001')));
    fx.tracker.seedEdge(ids.get(TASK('TRD-003')), ids.get(TASK('TRD-002-TEST')));

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expectMatchesOutputSchema(healthSpec(), envelope);
    expect(envelope.data.EDGES.checked).toBe(true);
    expect(envelope.data.EDGES.source).toBe('list');
    expect(envelope.data.EDGES.planned).toBe(plan.deps.length);
    expect(envelope.data.EDGES.missing).toEqual([
      { blocked: PHASE_1, blocker: TASK('TRD-001'), type: 'task-blocks-story' },
    ]);
    expect(envelope.data.EDGES.extra).toEqual([
      { blocked: TASK('TRD-003'), blocker: TASK('TRD-002-TEST') },
    ]);
    expect(envelope.data.EDGES.unresolved).toEqual([]);
    expect(envelope.data.BEADS).toEqual({ found: 12, planned: 12 });
    expect(envelope.data.MODE).toBe('health');
    expect(envelope.data.TRD_SLUG).toBe(SLUG);
    expect(envelope.data.TRD_FILE_PATH).toBe(TRD_PATH);
  });

  test('a planned edge whose endpoint bead is gone is unresolved, not missing', () => {
    const fx = healthRepo();
    const ids = idsByPrefix(fx);
    // The epic is the one bead no other bead depends on, so removing it leaves no dangling
    // link behind -- only two planned edges with nowhere to land.
    fx.tracker.removeIssue(ids.get(EPIC));

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.EDGES.missing).toEqual([]);
    expect(envelope.data.EDGES.unresolved).toEqual([
      { blocked: EPIC, blocker: PHASE_1, type: 'story-blocks-epic' },
      { blocked: EPIC, blocker: PHASE_2, type: 'story-blocks-epic' },
    ]);
    expect(envelope.data.BEADS).toEqual({ found: 11, planned: 12 });
    expect(envelope.data.ROOT_EPIC_ID).toBeNull();
    expect(envelope.data.REFERENCES.beadContext).toEqual({ checked: false, missing: [], ok: null });
  });

  test('a tracker that reports no dependency data says so instead of reporting every edge missing', () => {
    const fx = healthRepo({ exposeDependencies: false, listDependencies: false });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.EDGES.checked).toBe(false);
    expect(envelope.data.EDGES.source).toBeNull();
    expect(envelope.data.EDGES.missing).toEqual([]);
    expect(envelope.data.EDGES.extra).toEqual([]);
    expect(envelope.data.EDGES.live).toBe(0);
    expect(typeof envelope.data.EDGES.reason).toBe('string');
    expect(envelope.data.WARNINGS).toContain(MESSAGES.edgesUnreadable(envelope.data.EDGES.reason));
  });

  test('a tracker whose list omits the links is read bead by bead instead', () => {
    const fx = healthRepo({ listDependencies: false });
    const ids = idsByPrefix(fx);
    fx.tracker.dropEdge(ids.get(PHASE_2), ids.get(TASK('TRD-004')));

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.EDGES.checked).toBe(true);
    expect(envelope.data.EDGES.source).toBe('show');
    expect(envelope.data.EDGES.missing).toEqual([
      { blocked: PHASE_2, blocker: TASK('TRD-004'), type: 'task-blocks-story' },
    ]);
  });
});

describe('the work-graph step gates the report', () => {
  test('a dependency cycle is refused with the findings', () => {
    const fx = healthRepo();
    const ids = idsByPrefix(fx);
    // TRD-002 already depends on TRD-001; this closes the loop.
    fx.tracker.seedEdge(ids.get(TASK('TRD-001')), ids.get(TASK('TRD-002')));

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('WORK_GRAPH_FINDINGS');
    expect(envelope.error.details.findings.length).toBeGreaterThan(0);
    expect(envelope.error.details.findings.some(finding => finding.type === 'cycle')).toBe(true);
    expect(envelope.error.message).toBe(
      MESSAGES.workGraphFindings(envelope.error.details.findings.length)
    );
  });

  test('an unavailable work-graph backend is warned about and skipped', () => {
    const fx = healthRepo({ workGraph: 'unavailable' });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expect(envelope.data.WORK_GRAPH.status).toBe('unavailable');
    expect(envelope.data.WORK_GRAPH.skipped).toEqual(['work-graph.plan', 'work-graph.graph-health']);
    expect(envelope.data.WORK_GRAPH.findings).toEqual([]);
    expect(
      envelope.data.WARNINGS.filter(warning => warning.startsWith('work-graph.'))
    ).toHaveLength(2);
  });

  test('a healthy graph is reported clean and dependency aware', () => {
    const fx = healthRepo();

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.WORK_GRAPH.status).toBe('clean');
    expect(envelope.data.WORK_GRAPH.findings).toEqual([]);
    expect(envelope.data.WORK_GRAPH.skipped).toEqual([]);
    expect(envelope.data.WORK_GRAPH.dependencyAware).toBe(true);
    expect(envelope.data.WORK_GRAPH.orderingSource).toBe('tracker-links');
  });
});

describe('references and labels are counted over this TRD\'s beads only', () => {
  test('two open beads without a References block are counted and warned about', () => {
    const fx = healthRepo();
    const ids = idsByPrefix(fx);
    fx.tracker.setDescription(ids.get(TASK('TRD-001')), 'no references here\n');
    fx.tracker.setDescription(ids.get(TASK('TRD-002')), 'none here either\n');

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expect(envelope.data.REFERENCES.missingCount).toBe(2);
    expect(envelope.data.REFERENCES.openScoped).toBe(12);
    expect(envelope.data.WARNINGS).toContain(MESSAGES.referencesWarning(2));
  });

  test('a bead-context failure is refused with every missing entry', () => {
    const fx = healthRepo();
    const ids = idsByPrefix(fx);
    fx.tracker.setDescription(
      ids.get(EPIC),
      '## References\nTRD: docs/TRD/missing.md\nRead-first: read the TRD.\n'
    );

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('BEAD_CONTEXT_FAILED');
    expect(envelope.error.message).toContain(
      'TRD file docs/TRD/missing.md cannot be read: ENOENT'
    );
    expect(envelope.error.details.missing).toContain(
      'TRD file docs/TRD/missing.md cannot be read: ENOENT'
    );
  });

  test('every scaffolded bead lacking the TRD label is counted, and a foreign TRD is not', () => {
    const fx = healthRepo({
      issues: [{ id: 'other-1', title: '[trd:widget-engine-v2] Implement TRD: other', type: 'epic' }],
    });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    // The default create path carries no labels, so every one of this TRD's 12 beads lacks it,
    // and the lookalike slug of another TRD is not one of them.
    expect(envelope.data.LABELS).toEqual({ expected: SLUG, missingCount: 12 });
    expect(envelope.data.BEADS.found).toBe(12);
    expect(envelope.data.REFERENCES.openScoped).toBe(12);
    expect(envelope.data.REFERENCES.missingCount).toBe(0);
    expect(envelope.data.WARNINGS).toContain(MESSAGES.labelsWarning(12, SLUG));
  });

  test('an empty tracker is refused as not scaffolded', () => {
    const fx = healthRepo({ scaffold: false });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('NOT_SCAFFOLDED');
    expect(envelope.error.message).toBe(MESSAGES.notScaffolded(SLUG));
  });
});

describe('the report changes nothing', () => {
  test('the tracker, its mutation log and the working tree are untouched, and two runs agree', () => {
    const fx = healthRepo();
    const hashBefore = fx.tracker.hash();
    const mutationsBefore = fx.tracker.mutations().length;
    const porcelainBefore = porcelain(fx);

    const first = run(fx);
    const second = run(fx);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(fx.tracker.hash()).toBe(hashBefore);
    expect(fx.tracker.mutations()).toHaveLength(mutationsBefore);
    expect(porcelain(fx)).toBe(porcelainBefore);
    // Nothing in the answer comes from a clock or a random value.
    expect(JSON.stringify(second.envelope.data)).toBe(JSON.stringify(first.envelope.data));
  });
});

describe('the verb is reachable, declared, and selective about its operand', () => {
  test('the registry publishes implement.bead-health and the published schemas', () => {
    const listed = runMain(['engine', 'verbs'], makeCtx());
    expect(listed.exitCode).toBe(0);
    expect(listed.envelope.data.verbs).toContainEqual({
      group: 'implement',
      name: 'bead-health',
      sideEffect: 'write',
      summary: healthSpec().summary,
    });

    const schema = runMain(['engine', 'schema', 'implement.bead-health'], makeCtx());
    expect(schema.exitCode).toBe(0);
    expect(schema.envelope.data.inputSchema).toEqual(healthSpec().inputSchema);
    expect(schema.envelope.data.outputSchema).toEqual(healthSpec().outputSchema);
  });

  test('a missing, absent or escaping operand is refused before the tracker is touched', () => {
    const fx = healthRepo({ scaffold: false });
    const before = fx.tracker.calls().length;

    const missing = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'bead-health'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.envelope.error.code).toBe('TRD_REQUIRED');

    const absent = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'bead-health', 'docs/TRD/nope.md'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(absent.exitCode).toBe(1);
    expect(absent.envelope.error.code).toBe('TRD_NOT_FOUND');

    const escaping = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'bead-health', '../outside.md'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(escaping.exitCode).toBe(2);
    expect(escaping.envelope.error.code).toBe('PATH_ESCAPE');

    expect(fx.tracker.calls()).toHaveLength(before);
  });

  test('the write flags of this verb do not exist yet', () => {
    const fx = healthRepo({ scaffold: false });

    const { envelope, exitCode } = run(fx, ['--label']);

    expect(exitCode).toBe(2);
    expect(envelope.error.code).toBe('UNKNOWN_FLAG');
    expect(fx.tracker.mutations()).toEqual([]);
  });
});
