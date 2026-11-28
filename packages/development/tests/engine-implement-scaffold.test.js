'use strict';

/**
 * TRD-011-TEST (TRD-2026-d571763f): `ensemble implement scaffold <trd>`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` from `lib/ensemble-cli.js`
 * through the real `buildRegistry()`, against a real git repository, with the real
 * `toolchain-cli.js` resolving a real adapter manifest and the real `trd-cli.js` producing the
 * scaffold plan. Nothing the verb decides -- which bead to create, which to reuse, which edge
 * to wire or remove -- is stubbed out inside the engine.
 *
 * The fixture `PATH` carries no real `br`, `kata` or `git-town`. The tracker is the stateful
 * stub of `tests/fixtures/engine/tracker-stub.js`, whose state and call log live outside the
 * project root, so "nothing was created" and "the working tree is untouched" are both read off
 * real evidence instead of the verb's own report.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildRegistry } = require('../lib/ensemble-cli');
const MESSAGES = require('../lib/engine/messages');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo, snapshotTree } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');

// The skill was thinned to the engine loop (TRD-021); these texts were copied from the prose below, kept verbatim
// in tests/fixtures/engine/skill-before-thinning/, so the engine can still be held to what it replaced.
const REFERENCE = path.join(__dirname, 'fixtures', 'engine', 'skill-before-thinning', 'reference-SKILL.md.txt');
const TRD_PATH = 'docs/TRD/widget-engine.md';
const SLUG = 'widget-engine';
const EPIC = `[trd:${SLUG}]`;
const PHASE_1 = `[trd:${SLUG}:phase:1]`;
const PHASE_2 = `[trd:${SLUG}:phase:2]`;
const TASK = id => `[trd:${SLUG}:task:${id}]`;

jest.setTimeout(300000);

function scaffoldSpec() {
  return buildRegistry().get('implement', 'scaffold');
}

/**
 * A repository whose TRD, tracker adapter and preflight record are all real.
 * @param {{adapter?: string, createParse?: boolean, declare?: object, issues?: object[],
 *   preflight?: boolean, trd?: object}} [options]
 * @returns {{binDir: string, env: object, root: string, tracker: object}}
 */
function trdRepo(options = {}) {
  const { preflight = true, trd = {}, ...stubOptions } = options;
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
  if (preflight) recordPreflight(fx);
  return fx;
}

/** Run the real toolchain preflight, so the side-effect gate of `tracker.create` is satisfied. */
function recordPreflight(fx, runId = 'r1') {
  const result = runMain(
    ['tool', 'preflight', '--require', 'tracker.list', '--require', 'tracker.create', '--run-id', runId],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
  expect(result.exitCode).toBe(0);
}

function run(fx, argv = [], globals = ['--run-id', 'r1', '--non-interactive']) {
  return runMain(
    [...globals, 'implement', 'scaffold', TRD_PATH, ...argv],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
}

/** The plan of record, read from the same `trd-cli` the verb drives. */
function scaffoldCalls(fx) {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
    { cwd: fx.root, encoding: 'utf8', env: fx.env }
  );
  return JSON.parse(out);
}

function porcelain(fx) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: fx.root, encoding: 'utf8', env: fx.env });
}

/**
 * The repository's own files. `.ensemble/state` is the toolchain's own ledger of the side
 * effects it ran and is excluded deliberately: what must not change is the project.
 * @param {string} root
 * @returns {string[]}
 */
function projectFiles(root) {
  return snapshotTree(root).paths.filter(file => !file.startsWith(path.join('.ensemble', 'state')));
}

/** Every create the stub was asked to perform, as title prefixes in call order. */
function createdPrefixes(fx) {
  return fx.tracker
    .mutations()
    .filter(argv => argv[0] === 'create' || argv[0] === 'create-detailed')
    .map(argv => String(argv[1]).split(':').slice(0, 10).join(':'))
    .map(title => (title.match(/^\s*(\[[^\]]+\])/) || [])[1] || title);
}

describe('a fresh scaffold creates the planned hierarchy, once, in plan order', () => {
  test('every planned bead and edge exists and the working tree is untouched', () => {
    const fx = trdRepo();
    const plan = scaffoldCalls(fx);
    const filesBefore = projectFiles(fx.root);
    const hashBefore = fileHashes(fx.root, filesBefore);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expectMatchesOutputSchema(scaffoldSpec(), envelope);

    // TRD:387 -- created in the plan's order, nothing re-derived from the TRD.
    expect(createdPrefixes(fx)).toEqual(plan.creates.map(entry => entry.titlePrefix));
    expect(envelope.data.BEADS).toEqual({ created: 12, reused: 0, total: 12 });
    expect(envelope.data.TRD_SLUG).toBe(SLUG);
    expect(envelope.data.TRD_FILE_PATH).toBe(TRD_PATH);
    expect(envelope.data.ADAPTER).toBe('fixture-tracker');
    expect(envelope.data.SYNCED).toBe(true);

    const titles = fx.tracker.issues().map(issue => issue.title);
    for (const entry of plan.creates) {
      expect(titles.filter(title => title.startsWith(entry.titlePrefix))).toHaveLength(1);
    }

    // TRD:390 -- every planned edge is wired, and the tracker holds exactly those edges.
    const idByPrefix = new Map(fx.tracker.issues().map(i => [i.title.match(/^(\[[^\]]+\])/)[1], i.id]));
    const expected = plan.deps.map(dep => ({
      blocked: idByPrefix.get(dep.blockedPrefix),
      blocker: idByPrefix.get(dep.blockerPrefix),
    }));
    expect(fx.tracker.edges().sort(byEdge)).toEqual(expected.sort(byEdge));
    expect(envelope.data.EDGES.added).toBe(plan.deps.length);
    expect(envelope.data.EDGES.planned).toBe(plan.deps.length);
    expect(envelope.data.EDGES.skipped).toBe(0);
    expect(envelope.data.EDGES.unresolved).toEqual([]);

    // The verb writes to the tracker, never to the repository.
    expect(porcelain(fx)).toBe('');
    expect(projectFiles(fx.root)).toEqual(filesBefore);
    expect(fileHashes(fx.root, filesBefore)).toEqual(hashBefore);
  });

  test('every bead is created before the first edge is wired', () => {
    const fx = trdRepo();
    const plan = scaffoldCalls(fx);

    expect(run(fx).exitCode).toBe(0);

    const verbs = fx.tracker.mutations().map(argv => argv[0]);
    const lastCreate = verbs.lastIndexOf('create');
    const firstDep = verbs.indexOf('dep-add');
    expect(lastCreate).toBeGreaterThan(-1);
    expect(firstDep).toBeGreaterThan(lastCreate);
    expect(verbs.filter(verb => verb === 'create')).toHaveLength(plan.creates.length);
  });
});

function byEdge(a, b) {
  return `${a.blocked}|${a.blocker}`.localeCompare(`${b.blocked}|${b.blocker}`);
}

function fileHashes(root, files) {
  return files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
}

describe('a re-run is idempotent', () => {
  test('a second run creates nothing and reuses every bead by its title prefix', () => {
    const fx = trdRepo();
    expect(run(fx).exitCode).toBe(0);
    const beadsBefore = JSON.stringify(fx.tracker.issues());
    const idsBefore = fx.tracker.issues().map(issue => issue.id);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    // TRD:388/389 -- the title-prefix cache reuses, so no bead is created twice.
    expect(envelope.data.BEADS).toEqual({ created: 0, reused: 12, total: 12 });
    expect(fx.tracker.issues().map(issue => issue.id)).toEqual(idsBefore);
    expect(
      fx.tracker.mutations().filter(argv => argv[0] === 'create' || argv[0] === 'create-detailed')
    ).toHaveLength(12);
    // TRD:390 -- adding an edge that already exists is a no-op, so no bead and no edge moved.
    expect(JSON.stringify(fx.tracker.issues())).toBe(beadsBefore);
  });

  test('two consecutive re-runs report byte-identical data', () => {
    const fx = trdRepo();
    expect(run(fx).exitCode).toBe(0);

    const first = run(fx);
    const second = run(fx);

    expect(JSON.stringify(second.envelope.data)).toBe(JSON.stringify(first.envelope.data));
  });
});

describe('a crash leaves a resumable scaffold', () => {
  test('a failed create refuses naming the bead, and the re-run finishes it', () => {
    const fx = trdRepo();
    const plan = scaffoldCalls(fx);
    const tenth = plan.creates[9].titlePrefix;
    fx.tracker.failCreateAt(10);

    const crashed = run(fx);

    // TRD:392 -- REFUSED naming the title prefix, and nothing further is created.
    expect(crashed.exitCode).toBe(1);
    expect(crashed.envelope.status).toBe('REFUSED');
    expect(crashed.envelope.error.code).toBe('CREATE_FAILED');
    expect(crashed.envelope.error.message).toContain(`could not create bead '${tenth}'`);
    expect(crashed.envelope.error.details.titlePrefix).toBe(tenth);
    expect(crashed.envelope.error.details.created).toBe(9);
    expect(fx.tracker.issues()).toHaveLength(9);
    expect(fx.tracker.edges()).toEqual([]);

    // TRD:389 -- the re-run creates only what is missing and reports both counts.
    const resumed = run(fx);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.envelope.data.BEADS).toEqual({ created: 3, reused: 9, total: 12 });
    expect(fx.tracker.issues()).toHaveLength(12);
    expect(resumed.envelope.data.EDGES.added).toBe(plan.deps.length);
  });

  test('a create that returns no id is refused before anything else is created', () => {
    const fx = trdRepo({ createParse: false });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(1);
    expect(envelope.error.code).toBe('CREATE_NO_ID');
    expect(envelope.error.message).toBe(MESSAGES.createNoId(EPIC));
    expect(envelope.error.details.titlePrefix).toBe(EPIC);
    // Exactly one create was attempted: the refusal stops the loop.
    expect(fx.tracker.mutations().filter(argv => argv[0] === 'create')).toHaveLength(1);
  });
});

describe('the scaffold returns the maps the later phases read', () => {
  test('ROOT_EPIC_ID, the story ids, TRD_TO_BEAD_MAP and PHASE_TASK_IDS are all bead ids', () => {
    const fx = trdRepo();

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    const id = prefix => fx.tracker.byPrefix(prefix).id;
    // TRD:393 -- the root epic id, a story id per phase, and the task map.
    expect(envelope.data.ROOT_EPIC_ID).toBe(id(EPIC));
    expect(envelope.data.PHASE_STORY_IDS).toEqual({ 1: id(PHASE_1), 2: id(PHASE_2) });
    expect(envelope.data.TRD_TO_BEAD_MAP).toEqual({
      'TRD-001': id(TASK('TRD-001')),
      'TRD-001-TEST': id(TASK('TRD-001-TEST')),
      'TRD-001-TEST-S1': id(TASK('TRD-001-TEST-S1')),
      'TRD-002': id(TASK('TRD-002')),
      'TRD-002-TEST': id(TASK('TRD-002-TEST')),
      'TRD-003': id(TASK('TRD-003')),
      'TRD-003-TEST': id(TASK('TRD-003-TEST')),
      'TRD-004': id(TASK('TRD-004')),
      'TRD-004-TEST': id(TASK('TRD-004-TEST')),
    });
    // Synthesized tests come last within their phase.
    expect(envelope.data.PHASE_TASK_IDS['1']).toEqual([
      id(TASK('TRD-001')),
      id(TASK('TRD-001-TEST')),
      id(TASK('TRD-002')),
      id(TASK('TRD-002-TEST')),
      id(TASK('TRD-001-TEST-S1')),
    ]);
    expect(envelope.data.PHASE_TASK_IDS['2']).toEqual([
      id(TASK('TRD-003')),
      id(TASK('TRD-003-TEST')),
      id(TASK('TRD-004')),
      id(TASK('TRD-004-TEST')),
    ]);
  });
});

describe('a stale inter-phase edge from an older scaffold is repaired', () => {
  test('the edge first-task-of-phase-2 <- last-task-of-phase-1 is removed', () => {
    const fx = trdRepo();
    expect(run(fx).exitCode).toBe(0);
    // An older scaffold's gate: TRD-003 (first of phase 2) blocked by TRD-001-TEST-S1
    // (last of phase 1, synthesized tests last).
    const blocked = fx.tracker.byPrefix(TASK('TRD-003')).id;
    const blocker = fx.tracker.byPrefix(TASK('TRD-001-TEST-S1')).id;
    fx.tracker.seedEdge(blocked, blocker);

    const { envelope, exitCode } = run(fx);

    // TRD:395 -- removed through tracker.dep-remove.
    expect(exitCode).toBe(0);
    expect(envelope.data.STALE_EDGES.candidates).toBe(1);
    expect(envelope.data.STALE_EDGES.removed).toEqual([{ blocked, blocker }]);
    expect(envelope.data.STALE_EDGES.absent).toBe(0);
    expect(fx.tracker.mutations()).toContainEqual(['dep-remove', blocked, blocker]);
    expect(fx.tracker.edges()).not.toContainEqual({ blocked, blocker });
  });

  test('an edge-not-found failure is ignored and the run still succeeds', () => {
    const fx = trdRepo();

    const { envelope, exitCode } = run(fx);

    // TRD:395 -- "an edge-not-found failure is ignored".
    expect(exitCode).toBe(0);
    expect(envelope.data.STALE_EDGES.candidates).toBe(1);
    expect(envelope.data.STALE_EDGES.absent).toBe(1);
    expect(envelope.data.STALE_EDGES.removed).toEqual([]);
    expect(envelope.data.STALE_EDGES.failed).toBe(0);
  });

  test('a stale pair that the TRD actually declares is left alone', () => {
    const fx = trdRepo({ trd: { interPhaseDepends: true, synth: false } });
    expect(run(fx).exitCode).toBe(0);
    const blocked = fx.tracker.byPrefix(TASK('TRD-003')).id;
    const blocker = fx.tracker.byPrefix(TASK('TRD-002-TEST')).id;

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.STALE_EDGES.candidates).toBe(0);
    expect(envelope.data.STALE_EDGES.skipped).toBe(1);
    expect(fx.tracker.mutations()).not.toContainEqual(['dep-remove', blocked, blocker]);
    expect(fx.tracker.edges()).toContainEqual({ blocked, blocker });
  });
});

describe('the kata adapter takes the documented path', () => {
  test('every bead is looked up by its external key and created with tracker.create-detailed', () => {
    const fx = trdRepo({ adapter: 'kata' });
    const plan = scaffoldCalls(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.ADAPTER).toBe('kata');
    // TRD:394 -- find-by-key before creating, and tracker.create-detailed to create.
    expect(fx.tracker.calls().filter(argv => argv[0] === 'find-by-key')).toHaveLength(12);
    expect(fx.tracker.mutations().filter(argv => argv[0] === 'create-detailed')).toHaveLength(12);
    expect(fx.tracker.mutations().filter(argv => argv[0] === 'create')).toHaveLength(0);
    expect(createdPrefixes(fx)).toEqual(plan.creates.map(entry => entry.titlePrefix));
    expect(envelope.data.EDGES.added).toBe(plan.deps.length);
  });

  test('a closed bead that the open-only list cannot see is found by key, not created again', () => {
    const fx = trdRepo({ adapter: 'kata' });
    expect(run(fx).exitCode).toBe(0);
    const closed = fx.tracker.byPrefix(TASK('TRD-002'));
    fx.tracker.setStatus(closed.id, 'closed');

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.BEADS).toEqual({ created: 0, reused: 12, total: 12 });
    expect(envelope.data.TRD_TO_BEAD_MAP['TRD-002']).toBe(closed.id);
    expect(fx.tracker.mutations().filter(argv => argv[0] === 'create-detailed')).toHaveLength(12);
  });

  test('two beads carrying one external key are refused, not guessed between', () => {
    const fx = trdRepo({
      adapter: 'kata',
      issues: [
        { id: 'dup-1', title: 'other one', external_ref: `trd:${SLUG}`, status: 'closed' },
        { id: 'dup-2', title: 'other two', external_ref: `trd:${SLUG}`, status: 'closed' },
      ],
    });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(1);
    expect(envelope.error.code).toBe('AMBIGUOUS_KEY');
    expect(envelope.error.message).toBe(
      MESSAGES.ambiguousKey(
        EPIC,
        `findByKey: 2 beads carry key 'trd:${SLUG}' (dup-1, dup-2); refusing to pick one`
      )
    );
    expect(fx.tracker.mutations()).toEqual([]);
  });

  test('tracker.create-detailed being undeclared falls back to tracker.create with one warning', () => {
    const fx = trdRepo({ adapter: 'kata', declare: { createDetailed: false } });
    const plan = scaffoldCalls(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(fx.tracker.mutations().filter(argv => argv[0] === 'create')).toHaveLength(12);
    expect(fx.tracker.mutations().filter(argv => argv[0] === 'create-detailed')).toHaveLength(0);
    expect(envelope.data.BEADS).toEqual({ created: 12, reused: 0, total: 12 });
    expect(envelope.data.WARNINGS.filter(w => w.includes('tracker.create-detailed'))).toHaveLength(1);
    expect(envelope.data.EDGES.added).toBe(plan.deps.length);
  });
});

describe('a tracker that cannot do everything degrades instead of lying', () => {
  test('tracker.dep-add undeclared leaves the beads, skips every edge and warns once', () => {
    const fx = trdRepo({ declare: { depAdd: false } });
    const plan = scaffoldCalls(fx);

    const { envelope, exitCode } = run(fx);

    // TRD:391 -- warn once, skip the edges, still report OK with a skipped count.
    expect(exitCode).toBe(0);
    expect(envelope.data.BEADS.created).toBe(12);
    expect(envelope.data.EDGES.added).toBe(0);
    expect(envelope.data.EDGES.skipped).toBe(plan.deps.length);
    expect(envelope.data.WARNINGS.filter(w => w.includes('tracker.dep-add'))).toHaveLength(1);
    expect(fx.tracker.mutations().filter(argv => argv[0] === 'dep-add')).toHaveLength(0);
  });

  test('tracker.dep-remove undeclared leaves the stale edge and warns once', () => {
    const fx = trdRepo({ declare: { depRemove: false } });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.STALE_EDGES.removed).toEqual([]);
    expect(envelope.data.STALE_EDGES.absent).toBe(0);
    expect(envelope.data.WARNINGS.filter(w => w.includes('tracker.dep-remove'))).toHaveLength(1);
  });

  test('an unreadable tracker is UNAVAILABLE and creates nothing', () => {
    const fx = trdRepo();
    fs.rmSync(fx.tracker.state);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(5);
    expect(envelope.status).toBe('UNAVAILABLE');
    expect(fs.existsSync(fx.tracker.state)).toBe(false);
  });

  test('a duplicated title prefix reuses the first bead and names both in a warning', () => {
    const fx = trdRepo({
      issues: [
        { id: 'dup-1', title: `${EPIC} TRD: Widget Engine` },
        { id: 'dup-2', title: `${EPIC} TRD: Widget Engine (copy)` },
      ],
    });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.ROOT_EPIC_ID).toBe('dup-1');
    expect(envelope.data.WARNINGS).toContain(
      MESSAGES.duplicatePrefixWarning(EPIC, ['dup-1', 'dup-2'], 'dup-1')
    );
  });
});

describe('the runtime gates are the toolchain\'s own and they can fail', () => {
  test('without a run id the side-effect preflight gate refuses before any bead exists', () => {
    const fx = trdRepo({ preflight: false });

    const { envelope, exitCode } = run(fx, [], ['--non-interactive']);

    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('PREFLIGHT_REQUIRED');
    expect(envelope.error.message).toContain(`could not create bead '${EPIC}'`);
    expect(fx.tracker.mutations()).toEqual([]);
  });

  test('an interactive run against an unconfirmed adapter refuses for confirmation', () => {
    const fx = trdRepo();

    const { envelope, exitCode } = runMain(
      ['--run-id', 'r1', 'implement', 'scaffold', TRD_PATH],
      makeCtx({ cwd: fx.root, env: { ...fx.env, CI: 'false' } })
    );

    expect(exitCode).toBe(1);
    expect(envelope.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(fx.tracker.mutations()).toEqual([]);
  });
});

describe('the verb is reachable, declared and selective about its operand', () => {
  test('the registry publishes implement.scaffold as a write verb with the published schemas', () => {
    const listed = runMain(['engine', 'verbs'], makeCtx());
    expect(listed.exitCode).toBe(0);
    expect(listed.envelope.data.verbs).toContainEqual({
      group: 'implement',
      name: 'scaffold',
      sideEffect: 'write',
      summary: scaffoldSpec().summary,
    });

    const schema = runMain(['engine', 'schema', 'implement.scaffold'], makeCtx());
    expect(schema.exitCode).toBe(0);
    expect(schema.envelope.data.inputSchema).toEqual(scaffoldSpec().inputSchema);
    expect(schema.envelope.data.outputSchema).toEqual(scaffoldSpec().outputSchema);
  });

  test('a missing, non-markdown or escaping operand is refused before the tracker is touched', () => {
    const fx = trdRepo();
    // The preflight already ran the adapter's health check; nothing after it may reach the stub.
    const before = fx.tracker.calls().length;

    const missing = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'scaffold'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.envelope.error.code).toBe('TRD_REQUIRED');

    const absent = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'scaffold', 'docs/TRD/nope.md'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(absent.exitCode).toBe(1);
    expect(absent.envelope.error.code).toBe('TRD_NOT_FOUND');

    const escaping = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'scaffold', '../outside.md'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(escaping.exitCode).toBe(2);
    expect(escaping.envelope.error.code).toBe('PATH_ESCAPE');

    expect(fx.tracker.calls()).toHaveLength(before);
  });
});

describe('the stale-edge rule is derived, not searched', () => {
  // Required inside each test, not at module load, so the rest of the file still runs when the
  // verb does not exist yet.
  const staleCandidates = (...args) =>
    require('../lib/engine/verbs/implement-scaffold').staleCandidates(...args);

  test('each phase N >= 2 contributes the documented pair', () => {
    const candidates = staleCandidates({
      beadByTaskId: { a1: 'b-a1', a2: 'b-a2', b1: 'b-b1', b2: 'b-b2', c1: 'b-c1' },
      phaseTaskIds: { 1: ['a1', 'a2'], 2: ['b1', 'b2'], 3: ['c1'] },
      plannedPairs: new Set(),
    });

    // REFERENCE:67 -- the first task bead of N, blocked by the last task bead of N-1.
    expect(candidates).toEqual([
      { blocked: 'b-b1', blocker: 'b-a2' },
      { blocked: 'b-c1', blocker: 'b-b2' },
    ]);
    expect(fs.readFileSync(REFERENCE, 'utf8')).toContain(
      'tracker.dep-remove --arg id=<first task bead of N> --arg dependsOnId=<last task bead of N-1>'
    );
  });

  test('a gap in the phase numbering and a planned pair both yield no candidate', () => {
    const gap = staleCandidates({
      beadByTaskId: { a1: 'b-a1', c1: 'b-c1' },
      phaseTaskIds: { 1: ['a1'], 3: ['c1'] },
      plannedPairs: new Set(),
    });
    expect(gap).toEqual([]);

    const planned = staleCandidates({
      beadByTaskId: { a1: 'b-a1', b1: 'b-b1' },
      phaseTaskIds: { 1: ['a1'], 2: ['b1'] },
      plannedPairs: new Set(['b-b1|b-a1']),
    });
    expect(planned).toEqual([]);
  });
});
