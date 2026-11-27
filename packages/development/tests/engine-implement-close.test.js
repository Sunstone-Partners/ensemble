'use strict';

/**
 * TRD-015-TEST (TRD-2026-d571763f): closure preconditions and checkbox sync --
 * `ensemble implement close | sync-checkboxes | report | pr-review`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` from `lib/ensemble-cli.js`
 * through the real `buildRegistry()`, against a real git repository whose tracker is the
 * stateful stub of `tests/fixtures/engine/tracker-stub.js`. Whether the epic closed is read off
 * the stub's own state and mutation log; whether a commit was made, and what it carries, off real
 * `git` output; whether a checkbox flipped, off the TRD file on disk. Never off the verb's report.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { buildRegistry } = require('../lib/ensemble-cli');
const { deriveStatus } = require('../lib/pr-review-status');
const { statePath, writeState } = require('../lib/pr-review-state');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo, writeToolchainYaml } = require('./helpers/engine-repo');
const { createTrackerStub, fixturePrd, fixtureTrd } = require('./fixtures/engine/tracker-stub');

const TRD_PATH = 'docs/TRD/widget-engine.md';
const PRD_PATH = 'docs/PRD/PRD-fixture.md';
const SLUG = 'widget-engine';
const BEADS_EXPORT = '.beads/issues.jsonl';
const SATISFIES = { 'TRD-001': 'REQ-001', 'TRD-003': 'REQ-002', 'TRD-004': 'REQ-003' };
const NOW = Math.floor(Date.UTC(2026, 2, 14, 12, 0, 0) / 1000);

jest.setTimeout(240000);

function spec(name) {
  return buildRegistry().get('implement', name);
}

/** A `workflow` adapter that really runs `git`: the closure's HEAD and commit are real. */
function writeWorkflowAdapter(fx) {
  const bin = path.join(fx.binDir, 'fixture-workflow');
  const source = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { execFileSync } = require('child_process');",
    'const argv = process.argv.slice(2);',
    "const git = args => execFileSync('git', args, { encoding: 'utf8' });",
    "if (argv[0] === 'status') { process.exit(0); }",
    "if (argv[0] === 'commit') { process.stdout.write(git(['commit', '-m', argv[1]])); process.exit(0); }",
    "if (argv[0] === 'merge-base') { process.stdout.write(git(['merge-base', argv[1], argv[2]]).trim()); process.exit(0); }",
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

function scaffoldCalls(fx) {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
    { cwd: fx.root, env: fx.env, encoding: 'utf8' }
  );
  return JSON.parse(out);
}

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, env: fx.env, encoding: 'utf8' }).trim();
}

/** A scaffolded TRD whose suite passes and whose completion review has not been recorded. */
function closeRepo(options = {}) {
  const { stub = {} } = options;
  const fx = makeRepo({
    files: {
      'README.md': 'widget engine\n',
      'package.json': `${JSON.stringify({
        name: SLUG,
        version: '1.0.0',
        scripts: { test: 'node -e "process.exit(0)"' },
      })}\n`,
      [TRD_PATH]: fixtureTrd({ prd: true, satisfies: SATISFIES, targetFiles: true }),
      [PRD_PATH]: fixturePrd(),
      [BEADS_EXPORT]: '',
    },
    init: false,
  });
  fx.tracker = createTrackerStub(fx.root, stub);
  writeWorkflowAdapter(fx);
  writeToolchainYaml(
    fx.root,
    `${fs.readFileSync(path.join(fx.root, '.ensemble', 'toolchain.yaml'), 'utf8')}workflow: fixture-workflow\n`
  );
  initRepo(fx, {});
  const preflight = runMain(
    ['tool', 'preflight', '--require', 'tracker.list', '--run-id', 'r1'],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
  expect(preflight.exitCode).toBe(0);
  fx.ids = fx.tracker.seedFromPlan(scaffoldCalls(fx));
  return fx;
}

function epicId(fx) {
  return fx.tracker.issues().find(issue => issue.type === 'epic').id;
}

/** Close every bead but the epic, which is what a finished build leaves behind. */
function finishBuild(fx) {
  for (const issue of fx.tracker.issues()) {
    if (issue.type !== 'epic') fx.tracker.setStatus(issue.id, 'closed');
  }
}

/** Record a whole-branch local review exactly as `review run` does: the status's own facts. */
function recordReview(fx, prId = `${SLUG}-completion`, overrides = {}) {
  const sha = git(fx, ['rev-parse', 'HEAD']);
  const tree = git(fx, ['rev-parse', 'HEAD^{tree}']);
  const status = deriveStatus({
    baseSha: sha,
    coverage: { gaps: [], status: 'complete' },
    findingCounts: { actionable: 0, awaitingDecision: 0, deferred: 0, total: 0 },
    headSha: sha,
    headTreeSha: tree,
    remotePhase: 'REMOTE_REVIEW_COMPLETE',
    reviewedHeadSha: sha,
    reviewedTreeSha: tree,
    roundsUsed: 0,
    tests: { command: 'npm test', exitCode: 0, passed: true },
    ...overrides,
  });
  const written = writeState(statePath(prId, fx.root), { ...status, headSha: sha, prId }, { cwd: fx.root });
  expect(written.ok).toBe(true);
  return status;
}

function run(fx, verb, argv = [], globals = ['--run-id', 'r1', '--non-interactive']) {
  return runMain(
    [...globals, 'implement', verb, TRD_PATH, ...argv],
    makeCtx({ cwd: fx.root, env: fx.env, now: NOW })
  );
}

const closed = fx => fx.tracker.mutations().some(argv => argv[0].startsWith('close'));

describe('close proceeds only when every precondition holds', () => {
  test('a finished build with a complete review closes the epic with the HEAD sha and commits only the beads', () => {
    const fx = closeRepo();
    finishBuild(fx);
    expect(recordReview(fx).localPhase).toBe('LOCAL_REVIEW_COMPLETE');
    const before = git(fx, ['rev-parse', 'HEAD']);

    const { envelope, exitCode } = run(fx, 'close');
    expect(envelope.status).toBe('OK');
    expect(exitCode).toBe(0);
    expectMatchesOutputSchema(spec('close'), envelope);
    expect(envelope.data).toMatchObject({ MODE: 'single-pr', OVERRIDDEN: false, REVIEW: 'complete', VERDICT: 'COMPLETE' });

    const epic = fx.tracker.issues().find(issue => issue.id === epicId(fx));
    expect(epic.status).toBe('closed');
    const closure = fx.tracker.closureOf(epic.id);
    expect(closure.commit).toBe(before);
    expect(closure.reason.length).toBeGreaterThanOrEqual(40);
    expect(closure.reason).toContain(before);

    expect(git(fx, ['rev-parse', 'HEAD'])).not.toBe(before);
    expect(git(fx, ['show', '--name-only', '--format=', 'HEAD']).split('\n')).toEqual([BEADS_EXPORT]);
  });

  test('a non-interactive INCOMPLETE verdict is REFUSED before any change, flag or not', () => {
    const fx = closeRepo();
    finishBuild(fx);
    recordReview(fx);
    fx.tracker.setSuite({ exitCode: 1, output: 'FAIL tests/widget-store.test.js\n' });
    const before = git(fx, ['rev-parse', 'HEAD']);

    for (const flags of [[], ['--override-incomplete']]) {
      const { envelope, exitCode } = run(fx, 'close', flags);
      expect(exitCode).toBe(1);
      expect(envelope.status).toBe('REFUSED');
      expect(envelope.error.code).toBe('COMPLETION_INCOMPLETE');
    }
    expect(fx.tracker.issues().find(issue => issue.id === epicId(fx)).status).toBe('open');
    expect(closed(fx)).toBe(false);
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(before);
  });

  test('an open task bead is REFUSED and nothing is closed', () => {
    const fx = closeRepo();
    finishBuild(fx);
    recordReview(fx);
    const open = fx.ids[`[trd:${SLUG}:task:TRD-004]`];
    fx.tracker.setStatus(open, 'open');

    const { envelope, exitCode } = run(fx, 'close');
    expect(exitCode).toBe(1);
    expect(envelope.status).toBe('REFUSED');
    expect(['OPEN_BEADS', 'COMPLETION_INCOMPLETE']).toContain(envelope.error.code);
    expect(fx.tracker.issues().find(issue => issue.id === epicId(fx)).status).toBe('open');
    expect(closed(fx)).toBe(false);
  });

  test('a listing that cannot be parsed is REFUSED as if beads remained', () => {
    const fx = closeRepo();
    finishBuild(fx);
    recordReview(fx);
    const healthy = fx.tracker.snapshot();
    fx.tracker.restore('this is not a tracker listing');

    const { envelope, exitCode } = run(fx, 'close');
    fx.tracker.restore(healthy);
    expect(exitCode).not.toBe(0);
    expect(envelope.status).toBe('REFUSED');
    expect(fx.tracker.issues().find(issue => issue.id === epicId(fx)).status).toBe('open');
    expect(closed(fx)).toBe(false);
  });

  test('single-PR mode with no recorded review is REFUSED, and a review recorded for another head is too', () => {
    const fx = closeRepo();
    finishBuild(fx);

    let result = run(fx, 'close');
    expect(result.exitCode).toBe(1);
    expect(result.envelope.status).toBe('REFUSED');
    expect(result.envelope.error.code).toBe('COMPLETION_REVIEW_NOT_COMPLETE');
    expect(closed(fx)).toBe(false);

    // A review that left a finding open is not LOCAL_REVIEW_COMPLETE.
    recordReview(fx, `${SLUG}-completion`, {
      findingCounts: { actionable: 2, awaitingDecision: 0, deferred: 0, total: 2 },
    });
    result = run(fx, 'close');
    expect(result.envelope.status).toBe('REFUSED');
    expect(result.envelope.error.code).toBe('COMPLETION_REVIEW_NOT_COMPLETE');
    expect(closed(fx)).toBe(false);

    // Corrupt state is never read as a pass.
    fs.writeFileSync(statePath(`${SLUG}-completion`, fx.root), '{ not json');
    result = run(fx, 'close');
    expect(result.envelope.status).toBe('REFUSED');
    expect(closed(fx)).toBe(false);
  });
});

describe('sync-checkboxes flips exactly the closed tasks, once', () => {
  const taskLine = (text, id) => text.split('\n').find(line => line.includes(`**${id}**`));

  test('two closed task beads flip exactly those two lines, with the fixed commit', () => {
    const fx = closeRepo();
    git(fx, ['add', '-A']);
    for (const id of ['TRD-001', 'TRD-002']) fx.tracker.setStatus(fx.ids[`[trd:${SLUG}:task:${id}]`], 'closed');
    const original = fs.readFileSync(path.join(fx.root, TRD_PATH), 'utf8');

    const { envelope, exitCode } = run(fx, 'sync-checkboxes');
    expect(exitCode).toBe(0);
    expectMatchesOutputSchema(spec('sync-checkboxes'), envelope);
    expect(envelope.data.CHANGED.sort()).toEqual(['TRD-001', 'TRD-002']);

    const after = fs.readFileSync(path.join(fx.root, TRD_PATH), 'utf8');
    const flipped = original
      .split('\n')
      .map((line, i) => [line, after.split('\n')[i]])
      .filter(([a, b]) => a !== b);
    expect(flipped).toHaveLength(2);
    for (const [a, b] of flipped) expect(b).toBe(a.replace('[ ]', '[x]'));
    expect(taskLine(after, 'TRD-003')).toContain('[ ]');

    expect(git(fx, ['log', '-1', '--format=%s'])).toBe(
      'chore(trd): sync Master Task List checkboxes with closed beads'
    );
    expect(git(fx, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort()).toEqual(
      [BEADS_EXPORT, TRD_PATH].sort()
    );
  });

  test('a second run changes nothing, and a TRD edited since it was read is REFUSED', () => {
    const fx = closeRepo();
    fx.tracker.setStatus(fx.ids[`[trd:${SLUG}:task:TRD-001`.concat(']')], 'closed');
    expect(run(fx, 'sync-checkboxes').exitCode).toBe(0);
    const head = git(fx, ['rev-parse', 'HEAD']);
    const text = fs.readFileSync(path.join(fx.root, TRD_PATH), 'utf8');

    const second = run(fx, 'sync-checkboxes');
    expect(second.exitCode).toBe(0);
    expect(second.envelope.data.CHANGED).toEqual([]);
    expect(second.envelope.data.COMMIT).toBeNull();
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.readFileSync(path.join(fx.root, TRD_PATH), 'utf8')).toBe(text);

    fx.tracker.setStatus(fx.ids[`[trd:${SLUG}:task:TRD-003]`], 'closed');
    const stale = run(fx, 'sync-checkboxes', ['--expect-hash', 'deadbeef']);
    expect(stale.exitCode).toBe(1);
    expect(stale.envelope.status).toBe('REFUSED');
    expect(stale.envelope.error.code).toBe('TRD_CHANGED');
    expect(fs.readFileSync(path.join(fx.root, TRD_PATH), 'utf8')).toBe(text);
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(head);
  });
});

describe('report and pr-review read, and change nothing', () => {
  test('report names status, branch, strategy, epic id, per-requirement status and totals', () => {
    const fx = closeRepo();
    for (const id of ['TRD-001', 'TRD-001-TEST']) fx.tracker.setStatus(fx.ids[`[trd:${SLUG}:task:${id}]`], 'closed');
    const head = git(fx, ['rev-parse', 'HEAD']);

    const { envelope, exitCode } = run(fx, 'report');
    expect(exitCode).toBe(0);
    expectMatchesOutputSchema(spec('report'), envelope);
    expect(envelope.data).toMatchObject({
      BRANCH: git(fx, ['branch', '--show-current']),
      EPIC_ID: epicId(fx),
      STATUS: 'IN-PROGRESS',
      STRATEGY: 'tdd',
      TRD_SLUG: SLUG,
    });
    const byReq = Object.fromEntries(envelope.data.REQUIREMENTS.map(r => [r.req, r.status]));
    expect(byReq['REQ-001']).toBe('SATISFIED');
    expect(byReq['REQ-002']).toBe('NOT VERIFIED');
    expect(envelope.data.TOTALS.requirements).toBe(envelope.data.REQUIREMENTS.length);
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(head);
    expect(closed(fx)).toBe(false);
  });

  test('pr-review reports a missing, then a complete, completion review', () => {
    const fx = closeRepo();
    let result = run(fx, 'pr-review');
    expect(result.exitCode).toBe(0);
    expect(result.envelope.data.STATE).toBe('missing');

    recordReview(fx);
    result = run(fx, 'pr-review');
    expectMatchesOutputSchema(spec('pr-review'), result.envelope);
    expect(result.envelope.data).toMatchObject({ LOCAL_PHASE: 'LOCAL_REVIEW_COMPLETE', STATE: 'complete' });
  });
});
