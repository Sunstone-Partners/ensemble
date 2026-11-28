'use strict';

/**
 * TRD-017-TEST (TRD-2026-d571763f): the local review loop host -- `ensemble review run`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` through the real registry's own
 * wiring (`groups/review.js`) against a real git repository. The review runner itself is the one
 * seam: a scripted stand-in for `review-run-cli` answers the stdin payloads the engine sends it,
 * and logs what it received, so what the engine passed on is read off the log and what it
 * answered off the envelope. The pass/block decisions are made over `deriveStatus`'s real
 * output, never over a hand-written status. One scenario runs the REAL runner to show the verb
 * surfaces its refusal instead of inventing a review.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildRegistry } = require('../lib/ensemble-cli');
const { createRegistry } = require('../lib/engine/registry');
const { deriveStatus } = require('../lib/pr-review-status');
const { statePath, writeState } = require('../lib/pr-review-state');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { makeRepo } = require('./helpers/engine-repo');

jest.setTimeout(60000);

const RUN_ID = 'rr-1';
const REVIEW_RUN = 'review-run-1';

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, env: fx.env, encoding: 'utf8' }).trim();
}

/** A repo with two commits, so a base and a head both exist. */
function reviewRepo() {
  const fx = makeRepo({ files: { 'README.md': 'widget\n' } });
  fx.base = git(fx, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(fx.root, 'feature.js'), 'module.exports = 1;\n');
  git(fx, ['add', '--', 'feature.js']);
  git(fx, ['commit', '--quiet', '-m', 'feature']);
  fx.head = git(fx, ['rev-parse', 'HEAD']);
  return fx;
}

/**
 * A scripted `review-run-cli`: answers `script[n]` to its n-th call and appends
 * `{command, payload}` to a log outside the project. Its location is the only thing the test
 * changes about the verb.
 */
function stubRunner(fx, script) {
  const dir = `${fx.root}-runner`;
  fs.mkdirSync(dir, { recursive: true });
  const cli = path.join(dir, 'runner.js');
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
  fs.writeFileSync(path.join(dir, 'log.json'), '[]');
  fs.writeFileSync(
    cli,
    [
      "'use strict';",
      "const fs = require('fs');",
      "const path = require('path');",
      'const dir = __dirname;',
      "const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));",
      "const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));",
      "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
      'const answer = script[log.length];',
      'log.push({ command: process.argv[2], payload });',
      "fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(log));",
      "if (answer === undefined) { process.stderr.write('stub runner: no scripted answer\\n'); process.exit(7); }",
      "if (answer.__raw !== undefined) { process.stdout.write(answer.__raw); process.exit(answer.exit || 0); }",
      "process.stdout.write(JSON.stringify(answer) + '\\n');",
      'process.exit(answer.ok === true ? 0 : 1);',
    ].join('\n')
  );
  return { calls: () => JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8')), cli };
}

function registryWith(cli) {
  const registry = createRegistry();
  require('../lib/engine/groups/review').register(registry, { cliPath: cli });
  return registry;
}

function run(fx, runner, argv) {
  return runMain(
    ['--run-id', RUN_ID, ...argv],
    makeCtx({ cwd: fx.root, env: fx.env, registry: registryWith(runner.cli) })
  );
}

const PREPARE = fx => ['review', 'run', '--repo', 'acme/widget', '--pr', '7', '--base', fx.base, '--head', fx.head];
const COLLECT = (...more) => ['review', 'run', '--collect', '--review-run-id', REVIEW_RUN, ...more];

const agent = (name, extra = {}) => ({
  briefPath: `.ensemble/pr-review/run/${REVIEW_RUN}/briefs/${name}.md`,
  deadlineAt: 1000,
  deadlineAtIso: '1970-01-01T00:00:01.000Z',
  name,
  outPath: `.ensemble/pr-review/run/${REVIEW_RUN}/results/${name}.json`,
  prompt: `You are ${name}. Read the brief.  Keep  this spacing.`,
  role: 'reviewer',
  ...extra,
});

const dispatch = fx => ({
  agents: [agent('reviewer-1', { sliceId: 's1', paths: ['feature.js'] }), agent('security-lane', { role: 'security' })],
  headSha: fx.head,
  maxConcurrentAgents: 3,
  mode: { mode: 'light' },
  next: 'node review-run-cli.js collect  (payload {})',
  ok: true,
  round: 'review',
  rules: ['a rule'],
  runId: REVIEW_RUN,
  status: 'DISPATCH',
  wave: '1/1',
});

/** The runner's final answer for a facts record, with the status derived by the real function. */
function done(fx, facts = {}) {
  return {
    gate: { blockers: [], mergeable: true },
    headSha: fx.head,
    ok: true,
    reviewStatus: deriveStatus({
      baseSha: fx.base,
      coverage: { gaps: [], status: 'complete' },
      findingCounts: { actionable: 0, awaitingDecision: 0, deferred: 0, total: 0 },
      headSha: fx.head,
      remotePhase: 'REMOTE_REVIEW_COMPLETE',
      reviewedHeadSha: fx.head,
      roundsUsed: 0,
      tests: { command: 'npm test', exitCode: 0, passed: true },
      ...facts,
    }),
    runId: REVIEW_RUN,
    status: 'DONE',
    statePath: path.join(fx.root, '.ensemble', 'pr-review', 'pr-7.json'),
  };
}

describe('prepare hands the runner\'s own manifest to the model', () => {
  test('the agents equal the runner\'s manifest exactly and the runner got the base and repository', () => {
    const fx = reviewRepo();
    const manifest = dispatch(fx);
    const runner = stubRunner(fx, [manifest]);
    const out = run(fx, runner, PREPARE(fx));

    expect(out.exitCode).toBe(3);
    expect(out.envelope).toMatchObject({ ok: true, status: 'NEEDS_AGENT' });
    expect(out.envelope.data.agents).toEqual(manifest.agents);
    expect(out.envelope.data).toMatchObject({ baseHead: fx.head, reviewRunId: REVIEW_RUN, runnerStatus: 'DISPATCH' });
    expect(out.envelope.next.calls[0].args).toEqual(['--run-id', RUN_ID, 'review', 'run', '--collect', '--review-run-id', REVIEW_RUN]);

    expect(runner.calls()).toEqual([
      { command: 'prepare', payload: { baseSha: fx.base, pr: 7, repo: 'acme/widget', repoRoot: fx.root } },
    ]);
    expectMatchesOutputSchema(buildRegistry().get('review', 'run'), out.envelope);
  });

  test('a head other than the one prepared is REFUSED and nothing is dispatched', () => {
    const fx = reviewRepo();
    const manifest = { ...dispatch(fx), headSha: fx.base };
    const out = run(fx, stubRunner(fx, [manifest]), PREPARE(fx));

    expect(out.exitCode).toBe(1);
    expect(out.envelope).toMatchObject({ error: { code: 'HEAD_MISMATCH' }, status: 'REFUSED' });
    expect(out.envelope.data).toBeUndefined();
  });

  test('flags that make a payload key are passed, and a missing required flag is INVALID_INPUT without calling the runner', () => {
    const fx = reviewRepo();
    const runner = stubRunner(fx, [dispatch(fx)]);
    const out = run(fx, runner, ['review', 'run', '--repo', 'acme/widget', '--pr', '7']);
    expect(out.envelope).toMatchObject({ error: { code: 'MISSING_INPUT' }, status: 'INVALID_INPUT' });
    expect(runner.calls()).toEqual([]);

    run(fx, runner, [...PREPARE(fx), '--skip-precheck', '--dry-run', '--remediation-sha', 'abc1234']);
    expect(runner.calls()[0].payload).toMatchObject({ dryRun: true, remediationShas: ['abc1234'], skipPrecheck: true });
  });
});

describe('collect relays the runner\'s next step', () => {
  test('PENDING is NEEDS_AGENT again, naming what it waits on', () => {
    const fx = reviewRepo();
    const pending = { ok: true, retryAfterMs: 5000, round: 'review', runId: REVIEW_RUN, status: 'PENDING', waitingOn: ['reviewer-1'] };
    const runner = stubRunner(fx, [pending]);
    const out = run(fx, runner, COLLECT());

    expect(out.envelope.status).toBe('NEEDS_AGENT');
    expect(out.exitCode).toBe(3);
    expect(out.envelope.data.agents).toEqual([]);
    expect(out.envelope.data.runner).toMatchObject({ retryAfterMs: 5000, waitingOn: ['reviewer-1'] });
    expect(runner.calls()[0]).toEqual({ command: 'collect', payload: { repoRoot: fx.root, runId: REVIEW_RUN } });
  });

  test('a further wave arrives as NEEDS_AGENT with the new agents verbatim', () => {
    const fx = reviewRepo();
    const wave = { ...dispatch(fx), agents: [agent('verifier-1', { candidateIds: ['c1'], role: 'verifier' })], round: 'verify' };
    const out = run(fx, stubRunner(fx, [wave]), COLLECT());
    expect(out.envelope.status).toBe('NEEDS_AGENT');
    expect(out.envelope.data.agents).toEqual(wave.agents);
  });

  test('TRIAGE and ADJUDICATE come back as requests, and the model\'s files reach the runner unchanged', () => {
    const fx = reviewRepo();
    const triageAnswer = { candidates: [{ id: 'c1' }], ok: true, runId: REVIEW_RUN, status: 'TRIAGE' };
    const adjudicateAnswer = { adjudicate: [{ id: 'f1' }], ok: true, runId: REVIEW_RUN, status: 'ADJUDICATE' };
    const runner = stubRunner(fx, [triageAnswer, triageAnswer, adjudicateAnswer, adjudicateAnswer]);

    const first = run(fx, runner, COLLECT());
    expect(first.envelope).toMatchObject({ data: { runnerStatus: 'TRIAGE' }, status: 'NEEDS_AGENT' });
    expect(first.envelope.next.calls[0].args).toContain('--triage-file');

    const triageFile = path.join(fx.root, 'triage.json');
    fs.writeFileSync(triageFile, JSON.stringify({ additionalCandidates: [{ failureMode: 'x', locationOrLink: 'feature.js:1' }] }));
    run(fx, runner, COLLECT('--triage-file', 'triage.json'));
    expect(runner.calls()[1].payload.triage).toEqual({ additionalCandidates: [{ failureMode: 'x', locationOrLink: 'feature.js:1' }] });

    const second = run(fx, runner, COLLECT());
    expect(second.envelope).toMatchObject({ data: { runnerStatus: 'ADJUDICATE' }, status: 'NEEDS_AGENT' });
    const decisions = [{ disposition: 'deferred', id: 'f1', reason: 'tracked elsewhere' }];
    fs.writeFileSync(path.join(fx.root, 'adj.json'), JSON.stringify(decisions));
    run(fx, runner, COLLECT('--adjudications-file', 'adj.json'));
    expect(runner.calls()[3].payload.adjudications).toEqual(decisions);
  });

  test('a malformed payload file is INVALID_INPUT and the runner is not called', () => {
    const fx = reviewRepo();
    const runner = stubRunner(fx, [dispatch(fx)]);
    fs.writeFileSync(path.join(fx.root, 'bad.json'), '{"additionalCandidates": ');
    const out = run(fx, runner, COLLECT('--triage-file', 'bad.json'));
    expect(out.envelope).toMatchObject({ error: { code: 'INVALID_JSON' }, status: 'INVALID_INPUT' });
    expect(runner.calls()).toEqual([]);
  });
});

describe('the final status: only LOCAL_REVIEW_COMPLETE passes', () => {
  test('a complete review passes, and the verdict is the runner\'s answer unchanged', () => {
    const fx = reviewRepo();
    const answer = done(fx);
    expect(answer.reviewStatus.localPhase).toBe('LOCAL_REVIEW_COMPLETE');
    const out = run(fx, stubRunner(fx, [answer]), COLLECT());

    expect(out.exitCode).toBe(0);
    expect(out.envelope.data).toMatchObject({ REPORT_PATH: '.ensemble/pr-review/pr-7.json', VERDICT: 'PASS' });
    expect(out.envelope.data.RUNNER.reviewStatus).toEqual(JSON.parse(JSON.stringify(answer.reviewStatus)));
  });

  test.each([
    ['open findings', { findingCounts: { actionable: 2, awaitingDecision: 0, deferred: 0, total: 2 } }],
    ['a failing test run', { tests: { command: 'npm test', exitCode: 1 } }],
    ['incomplete coverage', { coverage: { gaps: [{ id: 'slice:s2' }], status: 'incomplete' } }],
  ])('DONE with %s is a named block with the report path, not a pass', (_label, facts) => {
    const fx = reviewRepo();
    const answer = done(fx, facts);
    expect(answer.reviewStatus.localPhase).not.toBe('LOCAL_REVIEW_COMPLETE');
    const out = run(fx, stubRunner(fx, [answer]), COLLECT());

    expect(out.exitCode).toBe(1);
    expect(out.envelope.status).toBe('REFUSED');
    expect(out.envelope.error).toMatchObject({ code: 'REVIEW_BLOCKED' });
    expect(out.envelope.error.details).toMatchObject({
      block: answer.reviewStatus.localPhase,
      reportPath: '.ensemble/pr-review/pr-7.json',
    });
    expect(out.envelope.error.details.reviewStatus).toEqual(JSON.parse(JSON.stringify(answer.reviewStatus)));
    expect(out.envelope.data).toBeUndefined();
  });

  test.each([
    ['a missing status', answer => { delete answer.reviewStatus; }],
    ['a status with no local phase', answer => { answer.reviewStatus = { status: 'REVIEW_COMPLETE' }; }],
    ['an unrecognised phase', answer => { answer.reviewStatus.localPhase = 'LOOKS_FINE'; }],
  ])('%s is a named block, never a pass', (_label, mutate) => {
    const fx = reviewRepo();
    const answer = done(fx);
    mutate(answer);
    const out = run(fx, stubRunner(fx, [answer]), COLLECT());
    expect(out.envelope.status).toBe('REFUSED');
    expect(out.envelope.error.code).toBe('REVIEW_BLOCKED');
    expect(out.envelope.error.details.reportPath).toBe('.ensemble/pr-review/pr-7.json');
  });
});

describe('the runner\'s refusals and outages are not softened', () => {
  test('RUN_INVALIDATED (the head moved) is REFUSED with the runner\'s own answer', () => {
    const fx = reviewRepo();
    const answer = { currentHead: fx.base, expectedHead: fx.head, ok: false, reason: 'head-moved', runId: REVIEW_RUN, status: 'RUN_INVALIDATED' };
    const out = run(fx, stubRunner(fx, [answer]), COLLECT());

    expect(out.exitCode).toBe(1);
    expect(out.envelope).toMatchObject({ error: { code: 'RUN_INVALIDATED' }, status: 'REFUSED' });
    expect(out.envelope.error.details).toMatchObject({ currentHead: fx.base, reason: 'head-moved' });
  });

  test('a PR that is not open is REFUSED, an unreadable head is UNAVAILABLE and bad input is INVALID_INPUT', () => {
    const fx = reviewRepo();
    const failed = reason => ({ error: `no: ${reason}`, ok: false, reason, status: 'RUN_FAILED' });
    const runner = stubRunner(fx, [failed('pr-not-open'), failed('head-unreadable'), failed('invalid-input')]);
    expect(run(fx, runner, COLLECT()).envelope.status).toBe('REFUSED');
    expect(run(fx, runner, COLLECT()).envelope.status).toBe('UNAVAILABLE');
    expect(run(fx, runner, COLLECT()).envelope.status).toBe('INVALID_INPUT');
  });

  test.each([
    ['no output at all', [{ __raw: '', exit: 3 }]],
    ['output that is not JSON', [{ __raw: 'Segmentation fault', exit: 0 }]],
    ['a runner that does not start', []],
  ])('%s is UNAVAILABLE, never an empty review', (_label, script) => {
    const fx = reviewRepo();
    const out = run(fx, stubRunner(fx, script), COLLECT());
    expect(out.exitCode).toBe(5);
    expect(out.envelope.status).toBe('UNAVAILABLE');
  });

  test('an ok answer with a status the verb does not know is not read as a review', () => {
    const fx = reviewRepo();
    const out = run(fx, stubRunner(fx, [{ ok: true, status: 'LGTM' }]), COLLECT());
    expect(out.envelope).toMatchObject({ error: { code: 'REVIEW_RUNNER_UNRECOGNISED' }, status: 'UNAVAILABLE' });
  });

  test('the real runner, asked about a repository it cannot reach, is surfaced as a refusal or outage, never a review', () => {
    const fx = reviewRepo();
    const out = runMain(
      ['--run-id', RUN_ID, ...PREPARE(fx), '--skip-precheck'],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(['REFUSED', 'UNAVAILABLE']).toContain(out.envelope.status);
    expect(out.exitCode).not.toBe(0);
    expect(out.envelope.data).toBeUndefined();
  });
});

describe('--mode remote is informational', () => {
  /** Record a state report exactly as a review does: the facts, with the status derived from them. */
  function record(fx, facts, pr = 7) {
    const status = deriveStatus({
      baseSha: fx.base,
      coverage: { gaps: [], status: 'complete' },
      findingCounts: { actionable: 0, awaitingDecision: 0, deferred: 0, total: 0 },
      headSha: fx.head,
      remotePhase: 'REMOTE_REVIEW_COMPLETE',
      reviewedHeadSha: fx.head,
      roundsUsed: 0,
      tests: { command: 'npm test', exitCode: 0, passed: true },
      ...facts,
    });
    const written = writeState(statePath(pr, fx.root), { ...status, headSha: fx.head, prId: String(pr) }, { cwd: fx.root });
    expect(written.ok).toBe(true);
    return status;
  }
  const remote = (fx, ...more) =>
    runMain(['review', 'run', '--mode', 'remote', ...more], makeCtx({ cwd: fx.root, env: fx.env }));

  test('a blocked remote review is reported and the exit code is 0', () => {
    const fx = reviewRepo();
    const status = record(fx, { remotePhase: 'REMOTE_REVIEW_BLOCKED' });
    expect(status.status).not.toBe('REVIEW_COMPLETE');
    const out = remote(fx, '--pr', '7');

    expect(out.exitCode).toBe(0);
    expect(out.envelope.status).toBe('OK');
    expect(out.envelope.data).toMatchObject({ INFORMATIONAL: true, MODE: 'remote', PR: 7, STATUS: status.status });
    expect(out.envelope.data.REMOTE_PHASE).toBe(status.remotePhase);
    expect(out.envelope.data.REASONS).toEqual(status.reasons);
    expectMatchesOutputSchema(buildRegistry().get('review', 'run'), out.envelope);
  });

  test('a complete remote review is reported as complete', () => {
    const fx = reviewRepo();
    record(fx, {});
    expect(remote(fx, '--pr', '7').envelope.data.STATUS).toBe('REVIEW_COMPLETE');
  });

  test('a phase whose PR was never created is pending with no PR, exit 0', () => {
    const fx = reviewRepo();
    const out = remote(fx);
    expect(out.exitCode).toBe(0);
    expect(out.envelope.data).toMatchObject({ PR: null, REPORT_PATH: null, STATUS: 'REVIEW_PENDING' });
  });

  test.each([
    ['no recorded review', () => {}],
    ['a corrupt report', fx => {
      fs.mkdirSync(path.dirname(statePath(7, fx.root)), { recursive: true });
      fs.writeFileSync(statePath(7, fx.root), '{"headSha": ');
    }],
    ['a report recorded for another head', fx => {
      record(fx, {});
      const file = statePath(7, fx.root);
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), headSha: fx.base, reviewedTreeSha: undefined }));
    }],
    ['a directory where the report should be', fx => {
      fs.mkdirSync(statePath(7, fx.root), { recursive: true });
    }],
    ['a report that cannot be read', fx => {
      // A dangling symlink: it exists as an entry but reading it fails, whoever runs the test.
      fs.mkdirSync(path.dirname(statePath(7, fx.root)), { recursive: true });
      fs.symlinkSync(path.join(fx.root, 'nowhere.json'), statePath(7, fx.root));
    }],
    ['a report whose status the engine cannot derive', fx => {
      fs.mkdirSync(path.dirname(statePath(7, fx.root)), { recursive: true });
      fs.writeFileSync(statePath(7, fx.root), JSON.stringify({ headSha: fx.head, status: 'FINE' }));
    }],
  ])('%s is recorded as REVIEW_PENDING and never refuses', (_label, setup) => {
    const fx = reviewRepo();
    setup(fx);
    const out = remote(fx, '--pr', '7');
    expect(out.exitCode).toBe(0);
    expect(out.envelope.data.STATUS).not.toBe('REVIEW_COMPLETE');
    expect(['REVIEW_PENDING', 'REVIEW_BLOCKED']).toContain(out.envelope.data.STATUS);
    expect(out.envelope.data.REPORT_PATH).toBe('.ensemble/pr-review/pr-7.json');
  });

  test('remote mode never starts the runner', () => {
    const fx = reviewRepo();
    const runner = stubRunner(fx, [dispatch(fx)]);
    record(fx, {});
    run(fx, runner, ['review', 'run', '--mode', 'remote', '--pr', '7']);
    expect(runner.calls()).toEqual([]);
  });
});

describe('discovery', () => {
  test('--describe lists review run with its input schema', () => {
    const { envelope } = runMain(['--describe'], makeCtx());
    const verb = envelope.data.verbs.find(v => v.group === 'review' && v.name === 'run');
    expect(verb.sideEffect).toBe('write');
    expect(Object.keys(verb.inputSchema.properties)).toEqual(expect.arrayContaining(['collect', 'mode', 'pr', 'review-run-id']));
  });
});
