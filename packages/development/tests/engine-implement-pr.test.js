'use strict';

/**
 * TRD-018-TEST (TRD-2026-d571763f): phase and completion pull requests, `ensemble implement pr`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` through the real `buildRegistry()`
 * against a real git repository whose `origin` is a real bare repository. The `workflow` and
 * `host` adapters are real adapters over stub binaries that run `git push` for real and append
 * every call they receive to a log outside the project. Whether something was pushed is read
 * off `git ls-remote`, and whether a pull request was created or proposed off that log -- never
 * off the verb's own report.
 *
 * The prose hand-off is driven end to end: the verb answers `NEEDS_AGENT`, the test writes the
 * result file the brief asks for, `implement accept` records it, and the verb is run again.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { buildRegistry } = require('../lib/ensemble-cli');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { fakeGitTown, initRepo, makeRepo, writeToolchainYaml } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');

const TRD_PATH = 'docs/TRD/widget-engine.md';
const SLUG = 'widget-engine';
const RUN = 'r1';
const LOGIN = 'octocat';
const PHASE_1_BRANCH = `feature/${SLUG}-phase-1`;
const PHASE_2_BRANCH = `feature/${SLUG}-phase-2`;
const SINGLE_BRANCH = `feature/${SLUG}`;
const TASK = id => `[trd:${SLUG}:task:${id}]`;
const PHASE_1_TASKS = ['TRD-001', 'TRD-001-TEST', 'TRD-002', 'TRD-002-TEST'];
const PROSE = {
  howToRevert: 'Run `git revert` on the merge commit of this pull request; no data or config step is needed.',
  risk: 'Low: the change only adds a storage module that nothing else calls yet.',
};

jest.setTimeout(240000);

/** The backend binaries: log every call, and really push when asked to. */
function writeBackendAdapters(fx) {
  const logFile = `${fx.root}-backend-calls.log`;
  const failFile = `${fx.root}-host-fails`;
  fx.backendLog = logFile;
  fx.hostFailFlag = failFile;

  const workflowBin = path.join(fx.binDir, 'fixture-workflow');
  fs.writeFileSync(
    workflowBin,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      "const fs = require('fs');",
      "const { execFileSync } = require('child_process');",
      'const argv = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(['workflow', ...argv]) + '\\n');`,
      "const git = args => execFileSync('git', args, { encoding: 'utf8' });",
      "if (argv[0] === 'status') process.exit(0);",
      "if (argv[0] === 'commit') { process.stdout.write(git(['commit', '-m', argv[1]])); process.exit(0); }",
      "if (argv[0] === 'merge-base') { process.stdout.write(git(['merge-base', argv[1], argv[2]]).trim()); process.exit(0); }",
      "if (argv[0] === 'push') { process.stdout.write(git(['push', '-u', 'origin', argv[1]])); process.exit(0); }",
      "if (argv[0] === 'branch-create') { process.stdout.write(git(['switch', '-c', argv[1]])); process.exit(0); }",
      "if (argv[0] === 'propose') { process.stdout.write(JSON.stringify({ id: '11', url: 'https://example.invalid/pull/11' })); process.exit(0); }",
      "process.stderr.write('stub fixture-workflow: unexpected ' + JSON.stringify(argv) + '\\n');",
      'process.exit(1);',
    ].join('\n'),
    { mode: 0o755 }
  );
  const hostBin = path.join(fx.binDir, 'fixture-host');
  fs.writeFileSync(
    hostBin,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      "const fs = require('fs');",
      'const argv = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(['host', ...argv]) + '\\n');`,
      `if (fs.existsSync(${JSON.stringify(failFile)})) { process.stderr.write('host is down\\n'); process.exit(1); }`,
      "if (argv[0] === 'create') { process.stdout.write(JSON.stringify({ id: '7', url: 'https://example.invalid/pull/7' })); process.exit(0); }",
      "process.stderr.write('stub fixture-host: unexpected ' + JSON.stringify(argv) + '\\n');",
      'process.exit(1);',
    ].join('\n'),
    { mode: 0o755 }
  );

  const install = (name, category, subs, capabilities, parse) => {
    const dir = path.join(fx.root, 'packages', 'fixture-pkg', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'adapter.yaml'),
      yaml.dump({
        adapter: name,
        allowlist: [{ bin: name, sub: subs }],
        binaries: [name],
        capabilities,
        categories: [category],
        contract: { [category]: '1.0' },
        detect: [],
        env: [],
        health: [],
        version: '1.0.0',
        ...(parse || {}),
      })
    );
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
  };
  const json = { format: 'json', map: { id: '$.id', url: '$.url' } };
  install('fixture-workflow', 'workflow', ['status', 'commit', 'merge-base', 'push', 'branch-create', 'propose'], {
    'workflow.branch-create': { run: ['fixture-workflow', 'branch-create', '${name}'] },
    'workflow.commit': { run: ['fixture-workflow', 'commit', '${message}'] },
    'workflow.merge-base': {
      parse: { format: 'text', map: { sha: '$' } },
      run: ['fixture-workflow', 'merge-base', '${refA}', '${refB}'],
    },
    'workflow.propose': {
      parse: json,
      run: ['fixture-workflow', 'propose', '${headBranch}', '${baseBranch}', '${title}'],
    },
    'workflow.push': { run: ['fixture-workflow', 'push', '${branch}'] },
    'workflow.status': { run: ['fixture-workflow', 'status'] },
  });
  install('fixture-host', 'host', ['create'], {
    'host.change-request-create': {
      parse: json,
      run: ['fixture-host', 'create', '${baseBranch}', '${headBranch}', '${title}', '${description}'],
    },
  });
}

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, encoding: 'utf8', env: fx.env }).trim();
}

/** The argv of every call the tracker stub received, flat, so the test-runner's own calls show. */
function callLog(fx) {
  return fx.tracker.calls().map(argv => argv.join(' '));
}

/** Every call the backends received, in order, as `['workflow', 'push', ...]` argv. */
function backendCalls(fx) {
  if (!fs.existsSync(fx.backendLog)) return [];
  return fs
    .readFileSync(fx.backendLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/** The backend calls that change something outside the repository: push, propose, create. */
function externalCalls(fx) {
  return backendCalls(fx).filter(call => ['push', 'propose', 'create'].includes(call[1]));
}

/** The branches the bare `origin` holds, read off git itself. */
function remoteBranches(fx) {
  const out = execFileSync('git', ['ls-remote', '--heads', fx.origin], { encoding: 'utf8', env: fx.env });
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t')[1].replace('refs/heads/', ''));
}

/**
 * A repository on `branch` with a bare `origin`, a real TRD and tracker, every phase-1 task
 * closed, and the toolchain wired to the fixture adapters.
 */
function prRepo({ branch = PHASE_1_BRANCH, gitTown = false } = {}) {
  const fx = makeRepo({
    files: {
      '.beads/issues.jsonl': '',
      'README.md': 'widget engine\n',
      'package.json': '{"name":"widget-engine","version":"1.0.0"}\n',
      [TRD_PATH]: fixtureTrd({ targetFiles: true }),
    },
    init: false,
  });
  fx.origin = `${fx.root}-origin.git`;
  fs.mkdirSync(fx.origin);
  execFileSync('git', ['init', '--quiet', '--bare', fx.origin], { env: fx.env });
  fx.tracker = createTrackerStub(fx.root, {});
  writeBackendAdapters(fx);
  writeToolchainYaml(
    fx.root,
    `${fs.readFileSync(path.join(fx.root, '.ensemble', 'toolchain.yaml'), 'utf8')}workflow: fixture-workflow\nhost: fixture-host\n`
  );
  initRepo(fx, { gitTownConfigured: gitTown, remote: fx.origin });
  if (gitTown) fakeGitTown(fx.binDir, '14.2.0');
  git(fx, ['branch', '-M', 'main']);
  git(fx, ['push', '--quiet', '-u', 'origin', 'main']);
  git(fx, ['switch', '--quiet', '-c', branch]);
  fs.writeFileSync(path.join(fx.root, 'widget.js'), 'module.exports = {};\n');
  git(fx, ['add', '--', 'widget.js']);
  git(fx, ['commit', '--quiet', '-m', 'add widget']);

  const preflight = runMain(
    ['tool', 'preflight', '--require', 'tracker.list', '--run-id', RUN],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
  expect(preflight.exitCode).toBe(0);
  const plan = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
      { cwd: fx.root, encoding: 'utf8', env: fx.env }
    )
  );
  fx.ids = fx.tracker.seedFromPlan(plan);
  for (const taskId of PHASE_1_TASKS) fx.tracker.setStatus(fx.ids[TASK(taskId)], 'closed');
  fx.tracker.setTestResult({ failed: 0, passed: 9, success: true, total: 9 });
  return fx;
}

/** Run `implement pr`. `extraEnv` carries the backend, branching and stacking choices. */
function runPr(fx, argv, extraEnv = {}) {
  const spec = buildRegistry().get('implement', 'pr');
  const result = runMain(
    ['--run-id', RUN, '--non-interactive', 'implement', 'pr', TRD_PATH, ...argv],
    makeCtx({ cwd: fx.root, env: { ...fx.env, ...extraEnv } })
  );
  if (result.envelope) expectMatchesOutputSchema(spec, result.envelope);
  return result;
}

const STACKED = { ENSEMBLE_BRANCHING_STRATEGY: 'plain-git', ENSEMBLE_USE_STACKED_PRS: 'true' };
const phase1 = ['--phase', '1', '--directed-by', LOGIN];

/** Answer the `pr-prose` hand-off the way the model would, then record it with `implement accept`. */
function supplyProse(fx, handOff, prose = PROSE) {
  const agent = handOff.data.agents[0];
  const result = { head: handOff.data.baseHead, role: 'pr-prose', step: agent.step, ...prose };
  fs.mkdirSync(path.dirname(path.join(fx.root, agent.outPath)), { recursive: true });
  fs.writeFileSync(path.join(fx.root, agent.outPath), JSON.stringify(result));
  const accepted = runMain(
    ['--run-id', RUN, 'implement', 'accept', '--step', agent.step, '--result-file', agent.outPath],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
  expect(accepted.envelope.data.ACCEPTED).toBe(true);
}

/** First run (hand-off), the model's answer, second run: the verb's real outcome. */
function runWithProse(fx, argv, extraEnv, prose) {
  const first = runPr(fx, argv, extraEnv);
  expect(first.envelope.status).toBe('NEEDS_AGENT');
  supplyProse(fx, first.envelope, prose);
  return runPr(fx, argv, extraEnv);
}

describe('the tests gate the PR', () => {
  test('failing full tests are REFUSED, and no prose was requested and nothing left the repository', () => {
    const fx = prRepo();
    fx.tracker.setTestResult({ failed: 2, passed: 7, success: false, total: 9 });

    const { envelope, exitCode } = runPr(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(exitCode).not.toBe(0);
    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('TESTS_FAILED');
    expect(envelope.error.message).toContain('PR creation blocked');
    expect(externalCalls(fx)).toEqual([]);
    expect(remoteBranches(fx)).toEqual(['main']);
    expect(fs.existsSync(path.join(fx.root, '.ensemble', 'state', 'engine', RUN, 'briefs'))).toBe(false);
  });

  test('the suite that runs is the whole one, not the phase files', () => {
    const fx = prRepo();
    runPr(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });
    const runs = callLog(fx).filter(line => line.startsWith('test-run '));

    expect(runs).toEqual(['test-run .']);
  });
});

describe('the Risk and How-to-revert prose is the model\'s, and only that', () => {
  test('no accepted prose: NEEDS_AGENT for pr-prose, bound to this branch, before anything is pushed', () => {
    const fx = prRepo();
    const { envelope, exitCode } = runPr(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(exitCode).toBe(3);
    expect(envelope.status).toBe('NEEDS_AGENT');
    const [agent] = envelope.data.agents;
    expect(agent.role).toBe('pr-prose');
    const brief = JSON.parse(fs.readFileSync(path.join(fx.root, agent.briefPath), 'utf8'));
    expect(brief.branch).toBe(PHASE_1_BRANCH);
    expect(brief.base).toBe(git(fx, ['merge-base', 'main', 'HEAD']));
    expect(envelope.next.verb).toBe('implement accept');
    expect(externalCalls(fx)).toEqual([]);
  });

  test('supplied prose is inserted unedited between the template headings', () => {
    const fx = prRepo();
    const { envelope } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.status).toBe('OK');
    expect(envelope.data.BODY).toContain(`## Risk\n${PROSE.risk}\n`);
    expect(envelope.data.BODY).toContain(`## How to revert\n${PROSE.howToRevert}\n`);
  });

  test('prose accepted for an earlier HEAD is not reused after a new commit', () => {
    const fx = prRepo();
    const first = runPr(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });
    supplyProse(fx, first.envelope);

    fs.writeFileSync(path.join(fx.root, 'more.js'), 'module.exports = 1;\n');
    git(fx, ['add', '--', 'more.js']);
    git(fx, ['commit', '--quiet', '-m', 'more']);

    const again = runPr(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });
    expect(again.envelope.status).toBe('NEEDS_AGENT');
    expect(externalCalls(fx)).toEqual([]);
  });
});

describe('the body is graded before anything is created', () => {
  test('a How to revert that says nothing is REFUSED naming the section, and nothing is pushed', () => {
    const fx = prRepo();
    const { envelope } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' }, { ...PROSE, howToRevert: '.' });

    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('PR_BODY_GRADE_FAILED');
    expect(envelope.error.message).toContain('how-to-revert');
    expect(envelope.error.message).not.toContain('risk');
    expect(externalCalls(fx)).toEqual([]);
    expect(remoteBranches(fx)).toEqual(['main']);
  });

  test('every section and the Directed by line are in a body the grader accepts', () => {
    const fx = prRepo();
    const { envelope } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });
    const body = envelope.data.BODY;

    expect(body).toContain(`PR/Phase 1 of TRD ${SLUG}.`);
    expect(body).toContain('**Shippable:** widgets can be stored');
    expect(body).toMatch(/Strategy: \w[\w-]*\. Tasks: .*TRD-001.*\. Bead: \S+\./);
    expect(body).toContain('## Testing');
    expect(body).toContain('PASSED (9/9)');
    expect(body).toContain('not measured');
  });
});

describe('Directed by names the person who asked', () => {
  test('the line carries the supplied login, not the agent', () => {
    const fx = prRepo();
    const { envelope } = runWithProse(fx, ['--phase', '1', '--directed-by', '@Some-Person'], { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.data.BODY).toMatch(/^Directed by: @Some-Person$/m);
    expect(envelope.data.BODY).not.toMatch(/claude|agent/i);
  });

  test.each([[[]], [['--directed-by', 'not a login!']]])('a missing or malformed login %j is REFUSED before any test run', extra => {
    const fx = prRepo();
    const before = callLog(fx).length;
    const { envelope } = runPr(fx, ['--phase', '1', ...extra], { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('DIRECTED_BY_REQUIRED');
    expect(callLog(fx).length).toBe(before);
  });
});

describe('the backend decides how the pull request is opened', () => {
  test('gh with git-town proposes, with no body, and never pushes', () => {
    const fx = prRepo({ gitTown: true });
    const { envelope } = runWithProse(fx, phase1, { ENSEMBLE_USE_STACKED_PRS: 'true', ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.data.BRANCHING_STRATEGY).toBe('git-town');
    expect(envelope.data.PR_URL).toBe('https://example.invalid/pull/11');
    expect(externalCalls(fx)).toEqual([['workflow', 'propose', PHASE_1_BRANCH, 'main', 'feat(widget-engine): Phase 1 — Core']]);
  });

  test('gh with plain git pushes the branch, then creates the change request with the graded body', () => {
    const fx = prRepo();
    const { envelope } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(remoteBranches(fx)).toContain(PHASE_1_BRANCH);
    const calls = externalCalls(fx);
    expect(calls.map(call => call[1])).toEqual(['push', 'create']);
    expect(calls[1].slice(2, 4)).toEqual(['main', PHASE_1_BRANCH]);
    expect(calls[1][5]).toBe(envelope.data.BODY);
    expect(envelope.data.PR_URL).toBe('https://example.invalid/pull/7');
    expect(envelope.data.PHASE_PR_MAP).toEqual({ 1: 'https://example.invalid/pull/7' });
  });

  test('ado with the Azure DevOps tool connected pushes and hands the create call to that tool', () => {
    const fx = prRepo();
    const tool = 'mcp__azure-devops__repo_create_pull_request';
    const { envelope } = runWithProse(fx, [...phase1, '--ado-tool', tool], { ...STACKED, ENSEMBLE_PR_BACKEND: 'ado' });

    expect(externalCalls(fx).map(call => call[1])).toEqual(['push']);
    expect(envelope.data.ADO_HANDOFF).toEqual({
      arguments: {
        description: envelope.data.BODY,
        sourceRefName: `refs/heads/${PHASE_1_BRANCH}`,
        targetRefName: 'refs/heads/main',
        title: 'feat(widget-engine): Phase 1 — Core',
      },
      call: 'repo_create_pull_request',
      tool,
    });
    expect(envelope.data.PR_CREATED).toBe(false);
    expect(envelope.data.PR_URL).toBeNull();
  });

  test('ado without the tool uses the change-request capability', () => {
    const fx = prRepo();
    const { envelope } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'ado' });

    expect(externalCalls(fx).map(call => call[1])).toEqual(['push', 'create']);
    expect(envelope.data.PR_CREATED).toBe(true);
    expect(envelope.data.ADO_HANDOFF).toBeNull();
  });

  test('ado without the tool, when the change request fails, prints manual instructions and does not refuse', () => {
    const fx = prRepo();
    fs.writeFileSync(fx.hostFailFlag, '');
    const { envelope, exitCode } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'ado' });

    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expect(envelope.data.PR_CREATED).toBe(false);
    expect(envelope.data.NOTE).toContain('create this pull request manually');
    expect(envelope.data.COMMANDS[0]).toMatch(/^gh pr create /);
  });

  test('manual returns the exact commands at every gate where a PR is due, and does nothing', () => {
    const fx = prRepo();
    const stacked = { ...STACKED, ENSEMBLE_PR_BACKEND: 'manual' };
    const { envelope } = runWithProse(fx, phase1, stacked);

    expect(backendCalls(fx).filter(call => call[1] !== 'merge-base')).toEqual([]);
    expect(remoteBranches(fx)).toEqual(['main']);
    expect(envelope.data.PR_CREATED).toBe(false);
    expect(envelope.data.COMMANDS[0]).toBe(`git push -u origin '${PHASE_1_BRANCH}'`);
    expect(envelope.data.COMMANDS[1]).toContain(`gh pr create --base 'main' --head '${PHASE_1_BRANCH}'`);
    expect(envelope.data.COMMANDS[1]).toContain(`--title 'feat(widget-engine): Phase 1 — Core'`);

    // The later gate where a PR is due gets its own commands, against the phase-1 branch as base.
    git(fx, ['switch', '--quiet', '-c', PHASE_2_BRANCH]);
    for (const taskId of ['TRD-003', 'TRD-003-TEST']) fx.tracker.setStatus(fx.ids[TASK(taskId)], 'closed');
    const second = runWithProse(fx, ['--phase', '2', '--directed-by', LOGIN], stacked);
    expect(second.envelope.data.COMMANDS[1]).toContain(`--base '${PHASE_1_BRANCH}'`);
    expect(backendCalls(fx).filter(call => call[1] !== 'merge-base')).toEqual([]);
  });
});

describe('stacked append', () => {
  test('git-town returns its native append instruction and calls no capability for it', () => {
    const fx = prRepo({ gitTown: true });
    const { envelope } = runWithProse(fx, phase1, { ENSEMBLE_USE_STACKED_PRS: 'true', ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.data.APPEND).toEqual({
      branch: PHASE_2_BRANCH,
      command: `git town append '${PHASE_2_BRANCH}'`,
      performed: false,
    });
    expect(backendCalls(fx).some(call => call[1] === 'branch-create')).toBe(false);
  });

  test('plain git creates the next branch off the current HEAD after the PR exists', () => {
    const fx = prRepo();
    const tip = git(fx, ['rev-parse', 'HEAD']);
    const { envelope } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.data.APPEND.performed).toBe(true);
    expect(git(fx, ['branch', '--show-current'])).toBe(PHASE_2_BRANCH);
    expect(git(fx, ['rev-parse', 'HEAD'])).toBe(tip);
    const order = backendCalls(fx).map(call => call[1]);
    expect(order.indexOf('create')).toBeGreaterThan(-1);
    expect(order.indexOf('branch-create')).toBeGreaterThan(order.indexOf('create'));
  });
});

describe('a created PR is open, never landed', () => {
  test('the URL is returned and nothing in the output says merged or landed', () => {
    const fx = prRepo();
    const { envelope } = runWithProse(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.data.PR_URL).toBe('https://example.invalid/pull/7');
    expect(JSON.stringify(envelope)).not.toMatch(/\b(merged|landed)\b/i);
    expect(envelope.data.NEXT).toContain('open for review');
  });
});

describe('the completion PR', () => {
  test('single-PR mode opens it from the TRD branch against the default branch', () => {
    const fx = prRepo({ branch: SINGLE_BRANCH });
    for (const taskId of ['TRD-003', 'TRD-003-TEST']) fx.tracker.setStatus(fx.ids[TASK(taskId)], 'closed');
    const env = { ENSEMBLE_BRANCHING_STRATEGY: 'plain-git', ENSEMBLE_PR_BACKEND: 'gh' };
    const { envelope } = runWithProse(fx, ['--completion', '--directed-by', LOGIN], env);

    expect(envelope.status).toBe('OK');
    expect(envelope.data.TARGET).toBe('completion');
    expect(envelope.data.BASE).toBe('main');
    expect(envelope.data.BODY).toMatch(new RegExp(`^Implements TRD ${SLUG}\\. Strategy: \\S+\\. 2 phases, \\d+ tasks`));
    expect(externalCalls(fx).map(call => call[1])).toEqual(['push', 'create']);
  });

  test('a phase PR is not due in single-PR mode', () => {
    const fx = prRepo({ branch: SINGLE_BRANCH });
    const { envelope } = runPr(fx, phase1, { ENSEMBLE_BRANCHING_STRATEGY: 'plain-git', ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.status).toBe('REFUSED');
    expect(envelope.error.code).toBe('PR_NOT_DUE');
    expect(externalCalls(fx)).toEqual([]);
  });

  test('stacked mode has no completion PR', () => {
    const fx = prRepo();
    const { envelope } = runPr(fx, ['--completion', '--directed-by', LOGIN], { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });
    expect(envelope.error.code).toBe('PR_NOT_DUE');
  });
});

describe('the request itself', () => {
  test('naming neither or both of --phase and --completion is REFUSED', () => {
    const fx = prRepo();
    for (const argv of [['--directed-by', LOGIN], ['--phase', '1', '--completion', '--directed-by', LOGIN]]) {
      const { envelope } = runPr(fx, argv, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });
      expect(envelope.error.code).toBe('PR_TARGET_REQUIRED');
    }
  });

  test('a branch other than the planned one is REFUSED and the engine does not switch', () => {
    const fx = prRepo();
    git(fx, ['switch', '--quiet', '-c', 'somewhere-else']);
    const { envelope } = runPr(fx, phase1, { ...STACKED, ENSEMBLE_PR_BACKEND: 'gh' });

    expect(envelope.error.code).toBe('BRANCH_MISMATCH');
    expect(git(fx, ['branch', '--show-current'])).toBe('somewhere-else');
  });
});
