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
const { execFileSync, spawn } = require('child_process');
const yaml = require('js-yaml');

const crypto = require('crypto');

const { buildRegistry } = require('../lib/ensemble-cli');
const { sortKeys } = require('../lib/engine/envelope');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');

const TRD_PATH = 'docs/TRD/widget-engine.md';
const SLUG = 'widget-engine';
const BRANCH = 'feature/widget-engine';
const REVIEW_POLICY = '# Review\n\n## Severity\n\n- **Important** \u2014 fixture-important: the change is wrong.\n- **Nit** \u2014 fixture-nit: a preference.\n- **Pre-existing** \u2014 fixture-pre: not this PR.\n\n```ensemble-review-policy\n{"sensitivePaths":["secure/**"],"highPaths":["wide/**"]}\n```\n';
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

/**
 * A `host` adapter whose `host.change-request-list` prints whatever the test last stored: the
 * pull requests the host "has". `failHost` makes it exit non-zero, as an unreachable host would.
 */
function writeHostAdapter(fx) {
  fx.hostFile = `${fx.root}-host.json`;
  fs.writeFileSync(fx.hostFile, '[]\n');
  const bin = path.join(fx.binDir, 'fixture-host');
  fs.writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const file = ${JSON.stringify(fx.hostFile)};`,
      "const text = fs.readFileSync(file, 'utf8');",
      "if (text.trim() === 'FAIL') { process.stderr.write('host unreachable\\n'); process.exit(1); }",
      'process.stdout.write(text);',
    ].join('\n') + '\n',
    { mode: 0o755 }
  );
  const skillDir = path.join(fx.root, 'packages', 'fixture-pkg', 'skills', 'fixture-host');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'adapter.yaml'),
    yaml.dump({
      adapter: 'fixture-host',
      version: '1.0.0',
      categories: ['host'],
      contract: { host: '1.0' },
      binaries: ['fixture-host'],
      allowlist: [{ bin: 'fixture-host', sub: ['list'] }],
      env: [],
      health: [],
      detect: [],
      capabilities: {
        'host.change-request-list': {
          run: ['fixture-host', 'list'],
          parse: {
            format: 'json',
            map: { items: '$' },
            arrayMap: {
              items: {
                source: '$',
                item: {
                  id: '$[0]',
                  url: '$[1]',
                  state: { path: '$[2]', statusMap: { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } },
                  baseBranch: '$[3]',
                  headBranch: '$[4]',
                },
              },
            },
          },
        },
      },
    })
  );
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# fixture-host\n');
  const config = path.join(fx.root, '.ensemble', 'toolchain.yaml');
  fs.writeFileSync(config, `${fs.readFileSync(config, 'utf8')}host: fixture-host\n`);
}

/** The pull requests the host reports as open, by head branch. */
function setPrs(fx, heads, base = 'main') {
  fs.writeFileSync(
    fx.hostFile,
    `${JSON.stringify(heads.map((head, index) => [String(index + 1), `https://host.invalid/pr/${index + 1}`, 'OPEN', base, head]))}\n`
  );
}

function failHost(fx) {
  fs.writeFileSync(fx.hostFile, 'FAIL\n');
}

function scaffoldCalls(fx) {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
    { cwd: fx.root, encoding: 'utf8', env: fx.env }
  );
  return JSON.parse(out);
}

function repo({ scaffolded = false, remote = null, bareOrigin = false } = {}) {
  const fx = makeRepo({
    files: {
      'README.md': 'widget engine\n',
      'package.json': '{"name":"widget-engine","version":"1.0.0"}\n',
      [TRD_PATH]: fixtureTrd({ targetFiles: true }),
      '.beads/issues.jsonl': '',
      'REVIEW.md': REVIEW_POLICY,
    },
    init: false,
    remote,
  });
  if (bareOrigin) {
    // A real origin: the whole-branch review compares against `origin/main` and fetches nothing.
    fx.origin = `${fx.root}-origin.git`;
    fs.mkdirSync(fx.origin);
    execFileSync('git', ['init', '--quiet', '--bare', fx.origin], { env: fx.env });
    remote = fx.origin;
  }
  registerAgents(fx.root);
  fx.tracker = createTrackerStub(fx.root, {});
  writeHostAdapter(fx);
  initRepo(fx, { remote });
  if (bareOrigin) {
    execFileSync('git', ['branch', '-M', 'main'], { cwd: fx.root, env: fx.env });
    execFileSync('git', ['push', '--quiet', '-u', 'origin', 'main'], { cwd: fx.root, env: fx.env });
    // The review state is gitignored in real repositories.
    fs.appendFileSync(path.join(fx.root, '.git', 'info', 'exclude'), '.ensemble/\n');
  }
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

function write(fx, relative, text) {
  fs.mkdirSync(path.dirname(path.join(fx.root, relative)), { recursive: true });
  fs.writeFileSync(path.join(fx.root, relative), text);
}

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, encoding: 'utf8', env: fx.env }).trim();
}

const taskIds = fx => Object.entries(fx.ids).filter(([prefix]) => prefix.includes(':task:')).map(([, id]) => id);
const epicId = fx => fx.ids[`[trd:${SLUG}]`];

/** The argv of a returned action's flags: exactly what a caller would type from `ACTION.args`. */
function flagsOf(args) {
  const out = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === true) out.push(`--${key}`);
    else if (Array.isArray(value)) for (const item of value) out.push(`--${key}`, String(item));
    else out.push(`--${key}`, String(value));
  }
  return out;
}

/** Run a returned action through the real entry point, as the model would. */
function runAction(fx, action, globals = NON_INTERACTIVE) {
  const [group, verb] = action.verb.split(' ');
  return runMain([...globals, group, verb, ...flagsOf(action.args)], makeCtx({ cwd: fx.root, env: fx.env }));
}

/** The reviewers answering a dispatch, as dispatched agents write `out-<name>.json`: every path read, no findings. */
function answerReviewers(manifest, paths) {
  for (const agent of manifest.agents) {
    fs.mkdirSync(path.dirname(agent.outPath), { recursive: true });
    fs.writeFileSync(agent.outPath, JSON.stringify({ findings: [], pathsReviewed: agent.paths || paths }));
  }
}

const REVIEW_PATHS = ['src/widget.js', 'src/widget.test.js'];
const WITH_NODE = ['--test-command', process.execPath, '--test-file', 'src/widget.test.js'];

/** The branch's own work, committed, so the whole-branch review has a diff to read. */
function commitBranchWork(fx) {
  fs.mkdirSync(path.join(fx.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, 'src', 'widget.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(fx.root, 'src', 'widget.test.js'), "if (require('./widget')() !== 1) process.exit(1);\n");
  git(fx, ['add', '--', 'src']);
  git(fx, ['commit', '--quiet', '-m', 'the widget and its test']);
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
    const fx = repo({ bareOrigin: true });
    // The origin is a plain path, so the PR backend is the caller's to name, on every call.
    const A = ['--pr-backend', 'gh', ...WITH_NODE];
    expect(nextId(fx, A)).toBe('checkout');

    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    expect(nextId(fx, A)).toBe('scaffold');

    fx.ids = fx.tracker.seedFromPlan(scaffoldCalls(fx));
    // The branch's own work lands after the scaffold (a fresh run would call newer sources stale).
    commitBranchWork(fx);
    let answer = next(fx, A).envelope.data;
    expect(answer.ACTION).toMatchObject({ id: 'delegate', kind: 'agent', verb: 'implement delegate' });
    expect(answer.ACTION.args['root-epic-id']).toBe(epicId(fx));
    expect(answer.ACTION.args['max-parallel']).toBe(3);
    expect(answer.COMPLETED).toEqual(['checkout', 'scaffold']);

    // One task left open: the build is not finished.
    const [last, ...rest] = taskIds(fx);
    for (const id of rest) fx.tracker.setStatus(id, 'closed');
    expect(nextId(fx, A)).toBe('delegate');

    fx.tracker.setStatus(last, 'closed');
    expect(nextId(fx, A)).toBe('gate-1');

    fx.tracker.setStatus(fx.ids[STORY(1)], 'closed');
    expect(nextId(fx, A)).toBe('gate-2');

    fx.tracker.setStatus(fx.ids[STORY(2)], 'closed');
    answer = next(fx, A).envelope.data;
    expect(answer.ACTION).toMatchObject({ id: 'review-completion', kind: 'agent', verb: 'review run' });
    // The action carries every argument it needs: nothing is left for the caller to invent.
    const head = git(fx, ['rev-parse', 'HEAD']);
    expect(answer.ACTION.args).toMatchObject({
      base: git(fx, ['merge-base', 'refs/remotes/origin/main', 'HEAD']),
      'base-ref': 'main',
      head,
      'review-id': `${SLUG}-completion`,
    });

    // Run THAT action through the real entry point and the real runner; the reviewers answer.
    const started = runAction(fx, answer.ACTION);
    expect(started.envelope.status).toBe('NEEDS_AGENT');
    expect(started.exitCode).toBe(3);
    expect(started.envelope.data.agents.length).toBeGreaterThan(0);
    answerReviewers(started.envelope.data, REVIEW_PATHS);
    const finished = runMain(started.envelope.next.calls[0].args, makeCtx({ cwd: fx.root, env: fx.env }));
    expect(finished.envelope.status).toBe('OK');
    expect(finished.envelope.data).toMatchObject({
      REPORT_PATH: `.ensemble/pr-review/pr-${SLUG}-completion.json`,
      VERDICT: 'PASS',
    });

    // The report `implement close` reads is the one the runner wrote, and `next` advances on it.
    const read = run(fx, 'pr-review');
    expect(read.envelope.data).toMatchObject({ HEAD_SHA: head, LOCAL_PHASE: 'LOCAL_REVIEW_COMPLETE', STATE: 'complete' });
    answer = next(fx, A).envelope.data;
    expect(answer.ACTION.id).toBe('close');
    expect(answer.COMPLETED).toEqual(['checkout', 'scaffold', 'delegate', 'gate-1', 'gate-2', 'review-completion']);

    // The review belongs to the head it read: a later commit makes it due again, with the new head.
    write(fx, 'src/extra.js', 'module.exports = 2;\n');
    git(fx, ['add', '--', 'src/extra.js']);
    git(fx, ['commit', '--quiet', '-m', 'a later commit']);
    answer = next(fx, A).envelope.data;
    expect(answer.ACTION.id).toBe('review-completion');
    expect(answer.ACTION.args.head).toBe(git(fx, ['rev-parse', 'HEAD']));
    expect(answer.ACTION.args.head).not.toBe(head);
    git(fx, ['reset', '--quiet', '--hard', head]);
    expect(nextId(fx, A)).toBe('close');

    fx.tracker.setStatus(epicId(fx), 'closed');
    expect(nextId(fx, A)).toBe('sync-checkboxes');

    const file = path.join(fx.root, TRD_PATH);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/- \[ \] \*\*/g, '- [x] **'));
    git(fx, ['commit', '--quiet', '-am', 'sync']);
    expect(nextId(fx, A)).toBe('pr-completion');

    // A pushed branch is not a pull request: origin carrying it changes nothing.
    git(fx, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`]);
    expect(nextId(fx, A)).toBe('pr-completion');

    // The host reporting an open pull request from the branch is what says the step happened.
    setPrs(fx, [BRANCH]);
    answer = next(fx, A).envelope.data;
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
    setPrs(fx, [BRANCH]);

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

    // The branch exists locally and then on origin: still no pull request.
    git(fx, ['branch', '-f', phaseBranch, 'HEAD']);
    expect(nextId(fx, [], options)).toBe('pr-1');
    git(fx, ['update-ref', `refs/remotes/origin/${phaseBranch}`, phaseBranch]);
    expect(nextId(fx, [], options)).toBe('pr-1');

    // A pull request from some other branch is not this one's either.
    setPrs(fx, ['somebody/else']);
    expect(nextId(fx, [], options)).toBe('pr-1');

    setPrs(fx, [phaseBranch]);
    expect(nextId(fx, [], options)).toBe('gate-2');
  });
});

describe('pull request evidence is a pull request, and an outage is not "none yet"', () => {
  /** A finished build whose only outstanding step is the completion pull request. */
  function atCompletionPr() {
    const fx = repo({ scaffolded: true });
    git(fx, ['switch', '--quiet', '-c', BRANCH]);
    fx.tracker.setStatus(epicId(fx), 'closed');
    for (const id of taskIds(fx)) fx.tracker.setStatus(id, 'closed');
    const file = path.join(fx.root, TRD_PATH);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/- \[ \] \*\*/g, '- [x] **'));
    git(fx, ['commit', '--quiet', '-am', 'sync']);
    return fx;
  }

  test('a host that cannot answer is UNAVAILABLE, not a reason to ask for the step again or to skip it', () => {
    const fx = atCompletionPr();
    expect(nextId(fx)).toBe('pr-completion');
    failHost(fx);
    const { envelope, exitCode } = next(fx);
    expect(exitCode).toBe(5);
    expect(envelope.status).toBe('UNAVAILABLE');
    expect(envelope.error.code).toBe('PR_EVIDENCE_UNAVAILABLE');
  });

  test('the manual backend still observes the host: the step is due until a matching pull request exists, then it is done', () => {
    const fx = atCompletionPr();
    git(fx, ['update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD']);
    const manual = ['--pr-backend', 'manual'];

    const due = next(fx, manual);
    expect(due.exitCode).toBe(0);
    expect(due.envelope.data.ACTION).toMatchObject({
      args: { completion: true, 'pr-backend': 'manual' },
      id: 'pr-completion',
      verb: 'implement pr',
    });

    // The person opens it by hand; the host now says so.
    setPrs(fx, [BRANCH]);
    expect(next(fx, manual).envelope.data.STATE).toBe('COMPLETE');

    // A host that cannot be read is still an outage under the manual backend.
    failHost(fx);
    const outage = next(fx, manual);
    expect(outage.envelope.status).toBe('UNAVAILABLE');
    expect(outage.envelope.error.code).toBe('PR_EVIDENCE_UNAVAILABLE');
  });

  test('a pull request into the wrong base does not satisfy the step', () => {
    const fx = atCompletionPr();
    setPrs(fx, [BRANCH], 'release/9');
    expect(nextId(fx)).toBe('pr-completion');
    setPrs(fx, [BRANCH], 'main');
    expect(nextId(fx)).toBe('COMPLETE');
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

describe('the audit ledger never loses a record to a concurrent writer', () => {
  const ledgerDir = fx => path.join(fx.root, '.ensemble', 'state', 'engine', 'rc', 'ledger');

  test('eight processes finishing the same verb under one run id leave eight records, and an existing record survives', async () => {
    const fx = repo();
    const dir = ledgerDir(fx);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0001.json'), 'earlier record\n');

    const script = [
      "const { recordCall } = require(process.argv[1]);",
      'const n = Number(process.argv[3]);',
      "const call = { globals: { runId: 'rc' }, input: { trd: 'same', writer: n }, projectRoot: process.argv[2] };",
      "const wrote = recordCall(call, { status: 'OK', verb: 'implement plan', writer: n });",
      'process.exit(wrote ? 0 : 3);',
    ].join('\n');
    const ledger = path.join(__dirname, '..', 'lib', 'engine', 'ledger.js');
    const exits = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map(
        n =>
          new Promise(resolve => {
            const child = spawn(process.execPath, ['-e', script, ledger, fx.root, String(n)], { stdio: 'ignore' });
            child.on('close', resolve);
          })
      )
    );
    expect(exits).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();
    expect(names).toHaveLength(9);
    expect(fs.readFileSync(path.join(dir, '0001.json'), 'utf8')).toBe('earlier record\n');
    const records = names.slice(1).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    expect(new Set(records.map(record => record.seq)).size).toBe(8);
    expect(new Set(records.map(record => record.output_sha256)).size).toBe(8);
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
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

  test('every way a registered verb can end leaves a record: a refused flag, a refused input, a mounted legacy verb', () => {
    const fx = repo();
    const read = () =>
      fs
        .readdirSync(ledgerDir(fx))
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => JSON.parse(fs.readFileSync(path.join(ledgerDir(fx), name), 'utf8')));

    // The parser refuses the flag before any input exists.
    const flag = run(fx, 'plan', ['--no-such-flag']);
    expect(flag.envelope.status).toBe('INVALID_INPUT');
    // The schema refuses the value after the flags were read.
    const value = run(fx, 'plan', ['--max-parallel', '0']);
    expect(value.envelope.status).toBe('INVALID_INPUT');
    // A mounted legacy verb prints its own bytes and reports only an exit code.
    const legacy = runMain(['--run-id', 'r1', 'trd', 'parse', TRD_PATH], makeCtx({ cwd: fx.root, env: fx.env }));
    expect(legacy.exitCode).toBe(0);

    expect(read().map(record => [record.step, record.status])).toEqual([
      ['implement plan', 'INVALID_INPUT'],
      ['implement plan', 'INVALID_INPUT'],
      ['trd parse', 'LEGACY_EXIT_0'],
    ]);
    // The refusal the caller saw is unchanged by having been recorded.
    expect(flag.envelope.error.code).toBeDefined();
    expect(new Set(read().map(record => record.input_sha256)).size).toBe(3);
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
