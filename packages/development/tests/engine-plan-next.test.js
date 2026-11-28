'use strict';

/**
 * TRD-020-TEST (TRD-2026-d571763f): the planner and precondition enforcement.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` through the real `buildRegistry()`
 * against a real git repository whose tracker is the stateful stub of
 * `tests/fixtures/engine/tracker-stub.js`. "The tracker advanced" is done by changing that stub's
 * own state between calls (close a bead, add a comment), never by feeding `next` a different
 * input: a `next` that read anything but live state would not follow.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const crypto = require('crypto');

const { buildRegistry } = require('../lib/ensemble-cli');
const { sortKeys } = require('../lib/engine/envelope');
const { deriveStatus } = require('../lib/pr-review-status');
const { statePath, writeState } = require('../lib/pr-review-state');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');

const TRD_PATH = 'docs/TRD/widget-engine.md';
const SLUG = 'widget-engine';
const BRANCH = 'feature/widget-engine';
const AZURE_REMOTE = 'https://dev.azure.com/org/project/_git/repo';
const STORY = n => `[trd:${SLUG}:phase:${n}]`;

jest.setTimeout(240000);

/** The eight agents the default roster names, registered the way `engine-implement-team` does. */
const DEFAULT_AGENTS = [
  'advisor',
  'architect',
  'backend-developer',
  'code-reviewer',
  'documentation-specialist',
  'product-management-orchestrator',
  'tech-lead-orchestrator',
  'test-runner',
];

function registerAgents(root) {
  const pkg = path.join(root, 'packages', 'development');
  fs.mkdirSync(path.join(pkg, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ensemble-development' }));
  fs.mkdirSync(path.join(pkg, 'agents'), { recursive: true });
  for (const name of DEFAULT_AGENTS) {
    fs.writeFileSync(path.join(pkg, 'agents', `${name}.yaml`), `metadata:\n  name: ${name}\n  description: fixture agent\n`);
  }
}

function scaffoldCalls(fx) {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
    { cwd: fx.root, encoding: 'utf8', env: fx.env }
  );
  return JSON.parse(out);
}

function repo({ scaffolded = false, remote = null } = {}) {
  const fx = makeRepo({
    files: {
      'README.md': 'widget engine\n',
      'package.json': '{"name":"widget-engine","version":"1.0.0"}\n',
      [TRD_PATH]: fixtureTrd({ targetFiles: true }),
      '.beads/issues.jsonl': '',
    },
    init: false,
    remote,
  });
  registerAgents(fx.root);
  fx.tracker = createTrackerStub(fx.root, {});
  initRepo(fx, { remote });
  if (scaffolded) fx.ids = fx.tracker.seedFromPlan(scaffoldCalls(fx));
  return fx;
}

const NON_INTERACTIVE = ['--run-id', 'r1', '--non-interactive'];

function run(fx, verb, argv = [], { globals = NON_INTERACTIVE, env = {} } = {}) {
  return runMain(
    [...globals, 'implement', verb, TRD_PATH, ...argv],
    makeCtx({ cwd: fx.root, env: { ...fx.env, ...env } })
  );
}

/** `next`'s answer, with the envelope checked against the verb's own output schema. */
function next(fx, argv = [], options = {}) {
  const result = run(fx, 'next', argv, options);
  if (result.envelope.status === 'OK') expectMatchesOutputSchema(buildRegistry().get('implement', 'next'), result.envelope);
  return result;
}

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, encoding: 'utf8', env: fx.env }).trim();
}

const taskIds = fx => Object.entries(fx.ids).filter(([prefix]) => prefix.includes(':task:')).map(([, id]) => id);
const epicId = fx => fx.ids[`[trd:${SLUG}]`];

/** A whole-branch local review recorded exactly as `review run` does, for the current HEAD. */
function recordReview(fx, prId = `${SLUG}-completion`) {
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
  });
  const written = writeState(statePath(prId, fx.root), { ...status, headSha: sha, prId }, { cwd: fx.root });
  expect(written.ok).toBe(true);
}

/** The next action's id, asserting the call itself succeeded. */
function nextId(fx, argv, options) {
  const { envelope, exitCode } = next(fx, argv, options);
  expect({ error: envelope.error, exitCode, status: envelope.status }).toEqual({
    error: undefined,
    exitCode: 0,
    status: 'OK',
  });
  return envelope.data.ACTION ? envelope.data.ACTION.id : envelope.data.STATE;
}


describe('plan is a pure function of the TRD and the flags', () => {
  test('two runs are byte-equal, and neither the tracker nor the working tree moves them', () => {
    const fx = repo();
    const first = run(fx, 'plan');
    const second = run(fx, 'plan');
    expect(first.exitCode).toBe(0);
    expect(JSON.stringify(first.envelope)).toBe(JSON.stringify(second.envelope));
    expectMatchesOutputSchema(buildRegistry().get('implement', 'plan'), first.envelope);

    // Seed the tracker and close everything: a plan that peeked at either would change.
    fx.ids = fx.tracker.seedFromPlan(scaffoldCalls(fx));
    for (const id of taskIds(fx)) fx.tracker.setStatus(id, 'closed');
    const third = run(fx, 'plan');
    expect(JSON.stringify(third.envelope)).toBe(JSON.stringify(first.envelope));
  });

  test('the graph lists id, verb, kind, preconditions and products, in run order', () => {
    const { envelope } = run(repo(), 'plan');
    const steps = envelope.data.STEPS;
    expect(steps.map(step => step.id)).toEqual([
      'checkout',
      'scaffold',
      'delegate',
      'gate-1',
      'gate-2',
      'review-completion',
      'close',
      'sync-checkboxes',
      'pr-completion',
    ]);
    expect(steps.find(step => step.id === 'delegate')).toMatchObject({
      kind: 'agent',
      preconditions: ['EPIC_OPEN'],
      verb: 'implement delegate',
    });
    for (const step of steps) {
      expect(['engine', 'agent', 'choice']).toContain(step.kind);
      expect(step.preconditions.length).toBeGreaterThan(0);
      expect(step.produces.length).toBeGreaterThan(0);
    }
    expect(steps.find(step => step.id === 'gate-2').preconditions).toContain('PHASE_2_TASKS_CLOSED');
  });

  test('--plan-only stops the plan at the scaffold, and conflicts with --execute', () => {
    const fx = repo();
    const planOnly = run(fx, 'plan', ['--plan-only']);
    expect(planOnly.envelope.data.STEPS.map(step => step.id)).toEqual(['checkout', 'scaffold']);
    expect(planOnly.envelope.data.STOP_AFTER).toBe('scaffold');
    const both = run(fx, 'plan', ['--plan-only', '--execute']);
    expect(both.envelope.status).toBe('REFUSED');
    expect(both.envelope.error.code).toBe('PLAN_EXECUTE_EXCLUSIVE');
  });
});

describe('next follows live state, one step at a time', () => {
  test('from a fresh TRD to COMPLETE, each answer follows what the tracker, git and the TRD file now say', () => {
    const fx = repo();
    expect(nextId(fx)).toBe('checkout');

    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    expect(nextId(fx)).toBe('scaffold');

    fx.ids = fx.tracker.seedFromPlan(scaffoldCalls(fx));
    let answer = next(fx).envelope.data;
    expect(answer.ACTION).toMatchObject({ id: 'delegate', kind: 'agent', verb: 'implement delegate' });
    expect(answer.ACTION.args['root-epic-id']).toBe(epicId(fx));
    expect(answer.ACTION.args['max-parallel']).toBe(3);
    expect(answer.COMPLETED).toEqual(['checkout', 'scaffold']);

    // One task left open: the build is not finished.
    const [last, ...rest] = taskIds(fx);
    for (const id of rest) fx.tracker.setStatus(id, 'closed');
    expect(nextId(fx)).toBe('delegate');

    fx.tracker.setStatus(last, 'closed');
    expect(nextId(fx)).toBe('gate-1');

    fx.tracker.setStatus(fx.ids[STORY(1)], 'closed');
    expect(nextId(fx)).toBe('gate-2');

    fx.tracker.setStatus(fx.ids[STORY(2)], 'closed');
    expect(nextId(fx)).toBe('review-completion');

    recordReview(fx);
    answer = next(fx).envelope.data;
    expect(answer.ACTION.id).toBe('close');
    expect(answer.COMPLETED).toEqual(['checkout', 'scaffold', 'delegate', 'gate-1', 'gate-2', 'review-completion']);

    fx.tracker.setStatus(epicId(fx), 'closed');
    expect(nextId(fx)).toBe('sync-checkboxes');

    const file = path.join(fx.root, TRD_PATH);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/- \[ \] \*\*/g, '- [x] **'));
    git(fx, ['commit', '--quiet', '-am', 'sync']);
    expect(nextId(fx)).toBe('pr-completion');

    // `implement pr` pushes the branch; origin carrying it is what says the step happened.
    git(fx, ['update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD']);
    answer = next(fx).envelope.data;
    expect(answer.STATE).toBe('COMPLETE');
    expect(answer.ACTION).toBeNull();
  });

  test('a closed epic is COMPLETE, whatever stale evidence the earlier steps left behind', () => {
    const fx = repo({ scaffolded: true });
    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    // Nothing else is finished: open stories, open tasks, no review. The epic itself is closed.
    fx.tracker.setStatus(epicId(fx), 'closed');
    for (const id of taskIds(fx)) fx.tracker.setStatus(id, 'closed');
    const file = path.join(fx.root, TRD_PATH);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/- \[ \] \*\*/g, '- [x] **'));
    git(fx, ['commit', '--quiet', '-am', 'sync']);
    git(fx, ['update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD']);

    const { envelope, exitCode } = next(fx);
    expect(exitCode).toBe(0);
    expect(envelope.data.STATE).toBe('COMPLETE');
    expect(envelope.next).toBeNull();
  });

  test('a closed epic whose checkboxes are still unchecked is not COMPLETE', () => {
    const fx = repo({ scaffolded: true });
    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    fx.tracker.setStatus(epicId(fx), 'closed');
    for (const id of taskIds(fx)) fx.tracker.setStatus(id, 'closed');
    expect(nextId(fx)).toBe('sync-checkboxes');
  });

  test('--plan-only ends at EXIT once the scaffold exists', () => {
    const fx = repo();
    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    expect(nextId(fx, ['--plan-only'])).toBe('scaffold');
    fx.ids = fx.tracker.seedFromPlan(scaffoldCalls(fx));
    const { envelope, exitCode } = next(fx, ['--plan-only']);
    expect(exitCode).toBe(0);
    expect(envelope.data.STATE).toBe('EXIT');
    expect(envelope.data.ACTION).toBeNull();
  });
});

describe('stacked mode: the story stays open, so the gate leaves its own evidence', () => {
  const STACKED = { ENSEMBLE_USE_STACKED_PRS: 'true' };

  test('pr steps follow their gate, and the gate is done when its PASS comment is recorded', () => {
    const fx = repo({ scaffolded: true });
    const plan = run(fx, 'plan', [], { env: STACKED }).envelope.data.STEPS.map(step => step.id);
    expect(plan.slice(plan.indexOf('gate-1'), plan.indexOf('gate-1') + 4)).toEqual(['gate-1', 'pr-1', 'gate-2', 'pr-2']);

    // The branch `implement pr` will push for phase 1 is the saved plan's, from the one CLI that owns it.
    const phaseBranch = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'pr-plan', TRD_PATH, '--stacked', '--json'],
        { cwd: fx.root, encoding: 'utf8', env: fx.env }
      )
    ).actions.find(action => action.kind === 'phase-gate' && action.phaseN === 1).branch;
    const options = { env: STACKED };
    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    for (const id of taskIds(fx)) fx.tracker.setStatus(id, 'closed');
    expect(nextId(fx, [], options)).toBe('gate-1');

    // A FAIL is a recorded result but not a passed gate under a blocking strategy.
    fx.tracker.addComment(fx.ids[STORY(1)], 'Quality gate result: FAIL | passed: 1/2 | strategy: tdd');
    expect(nextId(fx, [], options)).toBe('gate-1');

    fx.tracker.addComment(fx.ids[STORY(1)], 'Quality gate result: PASS | passed: 2/2 | strategy: tdd');
    const answer = next(fx, [], options).envelope.data;
    expect(answer.ACTION).toMatchObject({ args: { phase: 1 }, id: 'pr-1', kind: 'agent', verb: 'implement pr' });

    // The phase branch exists and origin holds it: the PR step is evident in git.
    // Not pushed yet: the branch is only local, so the step is still outstanding.
    git(fx, ['branch', '-f', phaseBranch, 'HEAD']);
    expect(nextId(fx, [], options)).toBe('pr-1');
    git(fx, ['update-ref', `refs/remotes/origin/${phaseBranch}`, phaseBranch]);
    expect(nextId(fx, [], options)).toBe('gate-2');
  });
});

describe('a verb called out of order refuses, whatever the plan said', () => {
  test('gate, close and the completion PR on an unscaffolded TRD each name what is missing', () => {
    const fx = repo();
    // The plan says "checkout" is next; the verbs do not take the plan's word for anything.
    expect(nextId(fx)).toBe('checkout');

    const gate = run(fx, 'gate');
    expect(gate.exitCode).toBe(1);
    expect(gate.envelope.status).toBe('REFUSED');
    expect(gate.envelope.error.code).toBe('NOT_SCAFFOLDED');
    expect(gate.envelope.error.message).toContain(SLUG);

    const close = run(fx, 'close');
    expect(close.envelope.status).toBe('REFUSED');
    expect(close.envelope.error.code).toBe('COMPLETION_INCOMPLETE');

    const delegate = run(fx, 'delegate', ['--root-epic-id', 'st-404']);
    expect(delegate.envelope.status).toBe('REFUSED');
    expect(delegate.envelope.error.code).toBe('ROOT_EPIC_NOT_SCOPED');

    expect(fx.tracker.mutations()).toEqual([]);
  });
});

describe('derivation steps are folded into next', () => {
  test('a fresh TRD returns args, env, team, branch and resume as context and the first mutating step as the action', () => {
    const fx = repo();
    const before = { head: git(fx, ['rev-parse', 'HEAD']), status: git(fx, ['status', '--porcelain']) };
    const { envelope } = next(fx);
    expect(Object.keys(envelope.data.CONTEXT).sort()).toEqual(['args', 'branch', 'env', 'resume', 'team']);
    expect(envelope.data.CONTEXT.resume.IS_RESUME).toBe(false);
    expect(envelope.data.CONTEXT.branch.BRANCH_ACTION).toBe('create');
    expect(envelope.data.CONTEXT.team.TEAM_ROLES).toBeDefined();
    expect(envelope.data.CONTEXT.env.PR_BACKEND).toBe('gh');
    expect(envelope.data.CONTEXT.args.MAX_PARALLEL).toBe(3);

    // The action is the first step that CHANGES something, never a derivation.
    expect(envelope.data.ACTION).toMatchObject({ id: 'checkout', verb: 'implement branch' });
    expect(['args', 'env', 'team', 'branch', 'resume']).not.toContain(envelope.data.ACTION.id);

    // Reading is all it did: nothing written, nothing created, nothing checked out.
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(before.head);
    expect(git(fx, ['status', '--porcelain'])).toBe(before.status);
    expect(git(fx, ['branch', '--show-current'])).not.toBe(BRANCH);
    expect(fx.tracker.mutations()).toEqual([]);
  });

  test('a derivation that needs the user is returned as it is, and asked again on the next call', () => {
    const fx = repo({ remote: AZURE_REMOTE });
    const interactive = { globals: ['--run-id', 'r1'] };
    const trdBefore = fs.readFileSync(path.join(fx.root, TRD_PATH), 'utf8');

    const first = next(fx, [], interactive);
    const second = next(fx, [], interactive);
    for (const { envelope, exitCode } of [first, second]) {
      expect(exitCode).toBe(4);
      expect(envelope.status).toBe('NEEDS_CHOICE');
      expect(envelope.data.CHOICE.id).toBe('pr_backend');
      expect(envelope.data.CHOICE.flag).toBe('--pr-backend');
      expect(envelope.next).toBeNull();
    }
    expect(JSON.stringify(second.envelope)).toBe(JSON.stringify(first.envelope));

    // Nothing was remembered: the TRD is untouched, and answering the flag moves the run on.
    expect(fs.readFileSync(path.join(fx.root, TRD_PATH), 'utf8')).toBe(trdBefore);
    const answered = next(fx, ['--pr-backend', 'manual'], interactive);
    expect(answered.envelope.data.CHOICE.id).not.toBe('pr_backend');
  });

  test('non-interactive, the same gap is a refusal that names the value to pass', () => {
    const fx = repo({ remote: AZURE_REMOTE });
    const { envelope, exitCode } = next(fx);
    expect(exitCode).toBe(1);
    expect(envelope.error.code).toBe('PR_BACKEND_UNRESOLVED');
  });
});

describe('the audit ledger records, is ignored by git and is never consulted', () => {
  const ledgerDir = fx => path.join(fx.root, '.ensemble', 'state', 'engine', 'r1', 'ledger');

  test('a verb under --run-id records its step, input hash, output hash and status, and git does not list it', () => {
    const fx = repo();
    const result = run(fx, 'plan');
    const files = fs.readdirSync(ledgerDir(fx));
    expect(files).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(path.join(ledgerDir(fx), files[0]), 'utf8'));
    const sha = value => crypto.createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex');
    expect(record).toMatchObject({
      input_sha256: sha({ trd: TRD_PATH }),
      output_sha256: sha(result.envelope),
      status: 'OK',
      step: 'implement plan',
    });

    // A different call is a different record, with different hashes.
    run(fx, 'plan', ['--plan-only']);
    const records = fs.readdirSync(ledgerDir(fx)).map(name => JSON.parse(fs.readFileSync(path.join(ledgerDir(fx), name), 'utf8')));
    expect(records).toHaveLength(2);
    expect(records[1].input_sha256).not.toBe(records[0].input_sha256);
    expect(records[1].output_sha256).not.toBe(records[0].output_sha256);

    expect(git(fx, ['status', '--porcelain', '--untracked-files=all'])).not.toContain('.ensemble');
  });

  test('a refused call is recorded with its status; a call without --run-id records nothing', () => {
    const fx = repo();
    run(fx, 'gate');
    const [name] = fs.readdirSync(ledgerDir(fx));
    expect(JSON.parse(fs.readFileSync(path.join(ledgerDir(fx), name), 'utf8')).status).toBe('REFUSED');

    const bare = repo();
    run(bare, 'plan', [], { globals: ['--non-interactive'] });
    expect(fs.existsSync(path.join(bare.root, '.ensemble', 'state', 'engine'))).toBe(false);
  });

  test('deleting the ledger does not change next, and a ledger that lies does not either', () => {
    const fx = repo({ scaffolded: true });
    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    for (const id of taskIds(fx)) fx.tracker.setStatus(id, 'closed');

    const withLedger = next(fx);
    expect(withLedger.envelope.data.ACTION.id).toBe('gate-1');
    expect(fs.readdirSync(ledgerDir(fx)).length).toBeGreaterThan(0);

    // Falsify every record: say each step finished with an unrelated output.
    for (const name of fs.readdirSync(ledgerDir(fx))) {
      fs.writeFileSync(path.join(ledgerDir(fx), name), JSON.stringify({ status: 'OK', step: 'implement close' }));
    }
    const lying = next(fx);
    // `next` writes its own record, so compare what it SAID, which carries no ledger content.
    expect(JSON.stringify(lying.envelope)).toBe(JSON.stringify(withLedger.envelope));

    fs.rmSync(path.join(fx.root, '.ensemble', 'state', 'engine'), { force: true, recursive: true });
    const deleted = next(fx, [], { globals: ['--non-interactive'] });
    expect(JSON.stringify(deleted.envelope)).toBe(JSON.stringify(withLedger.envelope));
  });
});
