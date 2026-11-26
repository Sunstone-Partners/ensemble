'use strict';

/**
 * TRD-013-TEST (TRD-2026-d571763f): phase gate decisions, `ensemble implement gate <trd>`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` from `lib/ensemble-cli.js`
 * through the real `buildRegistry()`, against a real git repository whose tracker is the
 * stateful stub of `tests/fixtures/engine/tracker-stub.js`, whose test runner is a second real
 * adapter, and whose `workflow` adapter really runs `git`. Nothing the verb decides -- which
 * phases are complete, what the tests said, whether a story closed, what the checkpoint commit
 * carries -- is stubbed out inside the engine.
 *
 * "The story was closed" is read off the stub's own state and mutation log; "a checkpoint was
 * made" is read off real `git` output. Never off the verb's own report.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { buildRegistry } = require('../lib/ensemble-cli');
const MESSAGES = require('../lib/engine/messages');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo, writeToolchainYaml } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');

/** The file the gate's verbatim texts come from. */
const REFERENCE = path.join(
  __dirname,
  '..',
  'skills',
  'ensemble-implement-trd-tasks',
  'references',
  'phase-4-quality-gate.md'
);

const TRD_PATH = 'docs/TRD/widget-engine.md';
const SLUG = 'widget-engine';
const BEADS_EXPORT = '.beads/issues.jsonl';
const PHASE_1 = `[trd:${SLUG}:phase:1]`;
const PHASE_2 = `[trd:${SLUG}:phase:2]`;
const TASK = id => `[trd:${SLUG}:task:${id}]`;
/** The four task beads of phase 1, as `scaffold-calls` names them. */
const PHASE_1_TASKS = ['TRD-001', 'TRD-001-TEST', 'TRD-002', 'TRD-002-TEST'];
/** The test files phase 1's TEST tasks declare, sorted, as the gate must pass them on. */
const PHASE_1_FILES = 'tests/widget-read.test.js tests/widget-store.test.js';

jest.setTimeout(240000);

function gateSpec() {
  return buildRegistry().get('implement', 'gate');
}

/**
 * A `workflow` adapter that really runs `git`: a checkpoint commit the test can read back out
 * of the repository is the only evidence that proves the gate committed anything.
 *
 * @param {{binDir: string, root: string}} fx
 */
function writeWorkflowAdapter(fx) {
  const bin = path.join(fx.binDir, 'fixture-workflow');
  const source = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { execFileSync } = require('child_process');",
    'const argv = process.argv.slice(2);',
    "const git = args => execFileSync('git', args, { encoding: 'utf8' });",
    "if (argv[0] === 'status') { process.exit(0); }",
    "if (argv[0] === 'commit') {",
    "  process.stdout.write(git(['commit', '-m', argv[1]]));",
    '  process.exit(0);',
    '}',
    "if (argv[0] === 'merge-base') {",
    "  process.stdout.write(git(['merge-base', argv[1], argv[2]]).trim());",
    '  process.exit(0);',
    '}',
    "process.stderr.write('stub fixture-workflow: unexpected ' + JSON.stringify(argv) + '\\n');",
    'process.exit(1);',
  ].join('\n');
  fs.writeFileSync(bin, `${source}\n`, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);

  const skillDir = path.join(fx.root, 'packages', 'fixture-pkg', 'skills', 'fixture-workflow');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'adapter.yaml'),
    yaml.dump({
      adapter: 'fixture-workflow',
      version: '1.0.0',
      categories: ['workflow'],
      contract: { workflow: '1.0' },
      binaries: ['fixture-workflow'],
      allowlist: [{ bin: 'fixture-workflow', sub: ['status', 'commit', 'merge-base'] }],
      env: [],
      health: [],
      detect: [],
      capabilities: {
        'workflow.status': { run: ['fixture-workflow', 'status'] },
        'workflow.commit': { run: ['fixture-workflow', 'commit', '${message}'] },
        'workflow.merge-base': {
          run: ['fixture-workflow', 'merge-base', '${refA}', '${refB}'],
          parse: { format: 'text', map: { sha: '$' } },
        },
      },
    })
  );
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# fixture-workflow\n');
}

/** The scaffold plan, from the same `trd-cli` verb the real scaffold drives. */
function scaffoldCalls(fx) {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
    { cwd: fx.root, encoding: 'utf8', env: fx.env }
  );
  return JSON.parse(out);
}

/**
 * A repository whose TRD, tracker, test runner, `workflow` adapter and preflight record are
 * real, and whose beads are seeded straight from the scaffold plan.
 *
 * Seeding from the plan rather than running `implement scaffold` keeps each scenario to a few
 * dozen child processes; the bead titles, types and labels are the same ones the scaffold
 * would have created, because they come from the same `trd-cli scaffold-calls` record.
 *
 * @param {{preflight?: boolean}} [options] everything else goes to the tracker stub
 * @returns {{binDir: string, env: object, ids: object, root: string, tracker: object}}
 */
function gateRepo(options = {}) {
  const { preflight = true, ...stubOptions } = options;
  const fx = makeRepo({
    files: {
      'README.md': 'widget engine\n',
      'package.json': '{"name":"widget-engine","version":"1.0.0"}\n',
      [TRD_PATH]: fixtureTrd({ targetFiles: true }),
      // Tracked and empty: `beads-stage` stages this TRD's beads into a file git already
      // follows, so the checkpoint commit has something real to carry.
      [BEADS_EXPORT]: '',
    },
    init: false,
  });
  fx.tracker = createTrackerStub(fx.root, stubOptions);
  writeWorkflowAdapter(fx);
  writeToolchainYaml(
    fx.root,
    `${fs.readFileSync(path.join(fx.root, '.ensemble', 'toolchain.yaml'), 'utf8')}workflow: fixture-workflow\n`
  );
  initRepo(fx, {});
  if (preflight) {
    const result = runMain(
      ['tool', 'preflight', '--require', 'tracker.list', '--run-id', 'r1'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(result.exitCode).toBe(0);
  }
  fx.ids = fx.tracker.seedFromPlan(scaffoldCalls(fx));
  return fx;
}

function run(fx, argv = [], globals = ['--run-id', 'r1', '--non-interactive']) {
  return runMain(
    [...globals, 'implement', 'gate', TRD_PATH, ...argv],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
}

/** Record an operator confirmation, as an interactive run of a write verb needs. */
function confirm(fx, capability) {
  const result = runMain(
    ['tool', 'confirm-record', capability, '--run-id', 'r1'],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
  expect(result.exitCode).toBe(0);
}

/** Close every task bead of phase 1, so `phase-status` reports the phase complete. */
function finishPhase1(fx) {
  for (const taskId of PHASE_1_TASKS) fx.tracker.setStatus(fx.ids[TASK(taskId)], 'closed');
}

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, encoding: 'utf8', env: fx.env }).trim();
}

/** The argv of every stub call, as flat strings, so order between calls is assertable. */
function callLog(fx) {
  return fx.tracker.calls().map(argv => argv.join(' '));
}

describe('a complete phase passes its gate and closes in single-PR mode', () => {
  test('the story closes with the HEAD sha, after the result was recorded, and the checkpoint carries only the beads', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });
    const before = git(fx, ['rev-parse', 'HEAD']);

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expectMatchesOutputSchema(gateSpec(), envelope);

    expect(envelope.data.MODE).toBe('single-pr');
    expect(envelope.data.STRATEGY).toBe('tdd');
    expect(envelope.data.GATES).toHaveLength(1);
    const gate = envelope.data.GATES[0];
    expect(gate.phase).toBe(1);
    expect(gate.story).toBe(fx.ids[PHASE_1]);
    expect(gate).toMatchObject({
      closed: true,
      comment: 'recorded',
      failed: 0,
      gatePassed: true,
      passed: 2,
      skipped: false,
      success: true,
      total: 2,
    });

    // The tracker's own record, not the verb's report.
    const story = fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]);
    expect(story.status).toBe('closed');
    const closure = fx.tracker.closureOf(fx.ids[PHASE_1]);
    expect(closure.commit).toBe(before);
    expect(closure.reason.length).toBeGreaterThanOrEqual(40);
    expect(closure.reason).toBe(
      MESSAGES.closureReasonPassed(1, { passed: 2, slug: SLUG, strategy: 'tdd', total: 2 })
    );

    // The result is evidence, so it must be on the story before anything is closed.
    const log = callLog(fx);
    const commentAt = log.findIndex(line => line.startsWith(`comment ${fx.ids[PHASE_1]} `));
    const closeAt = log.findIndex(line => line.startsWith(`close-with-reason ${fx.ids[PHASE_1]} `));
    expect(commentAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(commentAt);
    expect(fx.tracker.commentsOn(fx.ids[PHASE_1]).map(c => c.text)).toEqual([
      MESSAGES.qualityGateComment(true, 2, 2, 'tdd'),
    ]);

    // The phase's own test files were the ones handed to the runner.
    expect(log).toContain(`test-run ${PHASE_1_FILES}`);

    // Real git: a new checkpoint commit carrying the beads export and nothing else.
    expect(git(fx, ['rev-parse', 'HEAD'])).not.toBe(before);
    expect(git(fx, ['log', '-1', '--format=%s'])).toBe(
      MESSAGES.checkpointCommit(`${SLUG} phase`, 1, 2, 2)
    );
    expect(git(fx, ['show', '--name-only', '--format=', 'HEAD']).split('\n')).toEqual([
      BEADS_EXPORT,
    ]);
    expect(git(fx, ['status', '--porcelain', '--', TRD_PATH])).toBe('');
  });

  test('the comment and commit texts are the reference file\'s own, not a paraphrase', () => {
    const reference = fs.readFileSync(REFERENCE, 'utf8');
    expect(reference).toContain(
      'Quality gate result: <PASS|FAIL> | passed: <passed>/<total> | strategy: <strategy>'
    );
    expect(reference).toContain('checkpoint (tests pass; passed <passed>/<total>)');
    expect(MESSAGES.qualityGateComment(false, 1, 3, 'tdd')).toBe(
      'Quality gate result: FAIL | passed: 1/3 | strategy: tdd'
    );
    expect(MESSAGES.checkpointCommit('widget-engine phase', 2, 7, 7)).toBe(
      'chore(widget-engine phase 2): checkpoint (tests pass; passed 7/7)'
    );
  });
});

describe('a failing gate refuses under a blocking strategy', () => {
  test('the refusal names the failing tests, nothing is closed, and the FAIL result is still recorded', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({
      failed: 1,
      failures: [{ file: 'tests/widget-store.test.js', line: 12, test: 'stores a widget' }],
      passed: 1,
      success: false,
      total: 2,
    });

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('TESTS_FAILED');
    expect(envelope.error.message).toContain('tests/widget-store.test.js:12 stores a widget');
    expect(envelope.error.message).toContain(MESSAGES.ON_FAILURE_HINT.trim());

    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('open');
    expect(fx.tracker.mutations().some(argv => argv[0].startsWith('close'))).toBe(false);
    expect(fx.tracker.commentsOn(fx.ids[PHASE_1]).map(c => c.text)).toEqual([
      MESSAGES.qualityGateComment(false, 1, 2, 'tdd'),
    ]);
  });

  test('the same failure under characterization is informational: the story closes and the comment still says FAIL', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });

    const { envelope, exitCode } = run(fx, ['--strategy', 'characterization']);
    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expectMatchesOutputSchema(gateSpec(), envelope);
    expect(envelope.data.GATES[0]).toMatchObject({
      closed: true,
      gatePassed: true,
      strategy: 'characterization',
      success: false,
    });

    expect(fx.tracker.commentsOn(fx.ids[PHASE_1]).map(c => c.text)).toEqual([
      MESSAGES.qualityGateComment(false, 1, 2, 'characterization'),
    ]);
    expect(fx.tracker.closureOf(fx.ids[PHASE_1]).reason).toBe(
      MESSAGES.closureReasonInformational(1, {
        failed: 1,
        slug: SLUG,
        strategy: 'characterization',
        total: 2,
      })
    );
    expect(git(fx, ['log', '-1', '--format=%s'])).toBe(
      MESSAGES.checkpointCommitInformational(`${SLUG} phase`, 1, 1, 2)
    );
  });

  test('a repository that calls tdd informational in its own policy does not refuse', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });
    fs.writeFileSync(
      path.join(fx.root, '.ensemble', 'engine.yaml'),
      'strategy_gate:\n  tdd: informational\n'
    );

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(0);
    expect(envelope.data.GATES[0]).toMatchObject({
      closed: true,
      gatePassed: true,
      strategy: 'tdd',
      success: false,
    });
  });
});

describe('stacked mode defers the close to the PR', () => {
  test('the story stays open, nothing is committed, and the next step is stated', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });
    const before = git(fx, ['rev-parse', 'HEAD']);

    const { envelope, exitCode } = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'gate', TRD_PATH],
      makeCtx({ cwd: fx.root, env: { ...fx.env, ENSEMBLE_USE_STACKED_PRS: 'true' } })
    );
    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expectMatchesOutputSchema(gateSpec(), envelope);
    expect(envelope.data.MODE).toBe('stacked');
    expect(envelope.data.GATES[0]).toMatchObject({ closed: false, gatePassed: true });
    expect(envelope.data.GATES[0].commit).toBeNull();
    expect(envelope.data.NEXT).toContain(fx.ids[PHASE_1]);
    expect(envelope.data.NEXT).toContain('pre-PR test run');

    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('open');
    expect(fx.tracker.mutations().some(argv => argv[0].startsWith('close'))).toBe(false);
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(before);
  });
});

describe('the gate only runs where it is still needed', () => {
  test('a second run of the same phase adds no comment, no close and no commit', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });
    expect(run(fx).exitCode).toBe(0);

    const stateAfterFirst = fx.tracker.hash();
    const headAfterFirst = git(fx, ['rev-parse', 'HEAD']);

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(0);
    expect(envelope.data.GATES).toEqual([]);
    expect(envelope.data.NEXT).toBe(MESSAGES.NO_GATE_CANDIDATE);
    expect(envelope.data.PHASES_SKIPPED).toContainEqual({ phase: 1, reason: 'closed' });
    expect(fx.tracker.hash()).toBe(stateAfterFirst);
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(headAfterFirst);
  });

  test('a phase with an open task bead is skipped as incomplete and its tests never run', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    // Phase 2 has one task left open, so only phase 1 is a candidate.
    for (const taskId of ['TRD-003', 'TRD-003-TEST', 'TRD-004']) {
      fx.tracker.setStatus(fx.ids[TASK(taskId)], 'closed');
    }
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(0);
    expect(envelope.data.GATES.map(gate => gate.phase)).toEqual([1]);
    expect(envelope.data.PHASES_SKIPPED).toContainEqual({ phase: 2, reason: 'incomplete' });
    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_2]).status).toBe('open');
    // One test run only: phase 2 was never gated.
    expect(callLog(fx).filter(line => line.startsWith('test-run '))).toHaveLength(1);
  });
});

describe('a failing gate pauses for an interactive operator', () => {
  test('the three documented options are offered, after the result was recorded', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });
    confirm(fx, 'tracker.comment');

    const { envelope, exitCode } = run(fx, [], ['--run-id', 'r1']);
    expect(exitCode).toBe(4);
    expect(envelope.status).toBe('NEEDS_CHOICE');
    expectMatchesOutputSchema(gateSpec(), envelope);
    expect(envelope.data.CHOICE.id).toBe('gate_failure');
    expect(envelope.data.CHOICE.flag).toBe('--on-failure');
    expect(envelope.data.CHOICE.options.map(option => option.value)).toEqual([
      'fix',
      'skip',
      'abort',
    ]);
    expect(fx.tracker.commentsOn(fx.ids[PHASE_1]).map(c => c.text)).toEqual([
      MESSAGES.qualityGateComment(false, 1, 2, 'tdd'),
    ]);
    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('open');
  });

  test('abort stops, fix refuses, skip closes with the skipped texts, and non-interactive ignores the flag', () => {
    const aborted = gateRepo();
    finishPhase1(aborted);
    aborted.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });
    confirm(aborted, 'tracker.comment');
    const abortRun = run(aborted, ['--on-failure', 'abort'], ['--run-id', 'r1']);
    expect(abortRun.exitCode).toBe(1);
    expect(abortRun.envelope.error.code).toBe('GATE_ABORTED');
    expect(abortRun.envelope.error.message).toBe(MESSAGES.gateAborted(1));
    expect(aborted.tracker.issues().find(i => i.id === aborted.ids[PHASE_1]).status).toBe('open');

    const fixed = gateRepo();
    finishPhase1(fixed);
    fixed.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });
    confirm(fixed, 'tracker.comment');
    const fixRun = run(fixed, ['--on-failure', 'fix'], ['--run-id', 'r1']);
    expect(fixRun.exitCode).toBe(1);
    expect(fixRun.envelope.error.code).toBe('TESTS_FAILED');
    expect(fixed.tracker.issues().find(i => i.id === fixed.ids[PHASE_1]).status).toBe('open');

    const skipped = gateRepo();
    finishPhase1(skipped);
    skipped.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });
    confirm(skipped, 'tracker.comment');
    confirm(skipped, 'workflow.commit');
    const skipRun = run(skipped, ['--on-failure', 'skip'], ['--run-id', 'r1']);
    expect(skipRun.exitCode).toBe(0);
    expect(skipRun.envelope.data.GATES[0]).toMatchObject({
      closed: true,
      gatePassed: false,
      skipped: true,
      success: false,
    });
    expect(skipped.tracker.closureOf(skipped.ids[PHASE_1]).reason).toBe(
      MESSAGES.closureReasonSkipped(1, { failed: 1, slug: SLUG, total: 2 })
    );
    expect(git(skipped, ['log', '-1', '--format=%s'])).toBe(
      MESSAGES.checkpointCommitSkipped(`${SLUG} phase`, 1, 1, 2)
    );

    // The same flag in a non-interactive run is not consent: the gate still refuses.
    const unattended = gateRepo();
    finishPhase1(unattended);
    unattended.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });
    const unattendedRun = run(unattended, ['--on-failure', 'skip']);
    expect(unattendedRun.exitCode).toBe(1);
    expect(unattendedRun.envelope.error.code).toBe('TESTS_FAILED');
    expect(
      unattended.tracker.issues().find(i => i.id === unattended.ids[PHASE_1]).status
    ).toBe('open');
  });

  test('a failing phase gated twice records the FAIL result once', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 1, passed: 1, success: false, total: 2 });

    expect(run(fx).exitCode).toBe(1);
    expect(run(fx).exitCode).toBe(1);

    expect(fx.tracker.commentsOn(fx.ids[PHASE_1])).toHaveLength(1);
    const comments = callLog(fx).filter(line => line.startsWith(`comment ${fx.ids[PHASE_1]} `));
    expect(comments).toHaveLength(1);
  });
});

describe('the gate refuses rather than make a commit nobody reviewed', () => {
  test('a foreign staged path stops the close', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });
    fs.writeFileSync(path.join(fx.root, 'README.md'), 'edited by hand\n');
    git(fx, ['add', 'README.md']);

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(1);
    expect(envelope.error.code).toBe('STAGED_FOREIGN_PATHS');
    expect(envelope.error.message).toContain('README.md');
    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('open');
  });

  test('a closure reason below the repository\'s own floor stops the close', () => {
    const fx = gateRepo();
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });
    fs.writeFileSync(
      path.join(fx.root, '.ensemble', 'engine.yaml'),
      'closure_reason_min_length: 400\n'
    );

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(1);
    expect(envelope.error.code).toBe('CLOSURE_REASON_TOO_SHORT');
    expect(envelope.error.message).toContain('400');
    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('open');
  });
});

describe('the gate reads and closes through the tracker it was given', () => {
  test('a kata-shaped tracker reports the phase complete only because the listing asked for closed work', () => {
    const fx = gateRepo({ adapter: 'kata' });
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(0);
    expect(envelope.data.GATES.map(gate => gate.phase)).toEqual([1]);
    // A kata workspace lists open work only. Without the category's own `filter=all` the four
    // closed task beads would be invisible and the phase could never look complete.
    expect(callLog(fx)).toContain('list --all');
    expect(fx.tracker.closureOf(fx.ids[PHASE_1]).reason.length).toBeGreaterThanOrEqual(40);
  });

  test('a tracker without close-with-reason closes through tracker.close and says so', () => {
    const fx = gateRepo({ declare: { closeWithReason: false } });
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(0);
    expect(envelope.data.GATES[0].closed).toBe(true);
    expect(envelope.data.WARNINGS).toContain(
      MESSAGES.closeWithReasonFallback(fx.ids[PHASE_1])
    );
    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('closed');
    expect(fx.tracker.closureOf(fx.ids[PHASE_1])).toBeNull();
    expect(fx.tracker.mutations().some(argv => argv[0] === 'close')).toBe(true);
  });

  test('a project with no test runner is UNAVAILABLE, not a pass', () => {
    const fx = gateRepo({ declare: { testRunner: false } });
    finishPhase1(fx);

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(5);
    expect(envelope.status).toBe('UNAVAILABLE');
    expect(envelope.error.code).toBe('TEST_RUNNER_UNAVAILABLE');
    expect(fx.tracker.commentsOn(fx.ids[PHASE_1])).toEqual([]);
    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('open');
  });

  test('the toolchain\'s own preflight refusal is returned unchanged', () => {
    const fx = gateRepo({ preflight: false });
    finishPhase1(fx);
    fx.tracker.setTestResult({ failed: 0, passed: 2, success: true, total: 2 });

    const { envelope, exitCode } = run(fx);
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('PREFLIGHT_REQUIRED');
    expect(envelope.error.message).toContain('preflight');
    expect(fx.tracker.issues().find(issue => issue.id === fx.ids[PHASE_1]).status).toBe('open');
  });
});
