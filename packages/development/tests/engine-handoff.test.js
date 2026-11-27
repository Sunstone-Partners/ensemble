'use strict';

/**
 * TRD-016-TEST (TRD-2026-d571763f): the hand-off protocol and `implement accept`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` through the real `buildRegistry()`
 * against a real git repository. No shipped verb returns `NEEDS_AGENT` yet, so the scenarios
 * register one throwaway fixture verb on that real registry; it calls the same `handOff` and
 * `resolveChoice` a shipped verb will. What was recorded is read off the disk, and what HEAD is
 * off real `git`, never off the verb's own report.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildRegistry } = require('../lib/ensemble-cli');
const { MAX_RESULT_BYTES, handOff, resolveChoice } = require('../lib/engine/handoff');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { makeRepo } = require('./helpers/engine-repo');

const NOW = Math.floor(Date.UTC(2026, 10, 27, 12, 0, 0) / 1000);
const RUN = 'r1';

jest.setTimeout(60000);

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, env: fx.env, encoding: 'utf8' }).trim();
}

/** A repository on `main` with a feature branch checked out, the state `pr-prose` needs. */
function featureRepo() {
  const fx = makeRepo({ files: { 'README.md': 'widget\n' } });
  git(fx, ['branch', '-M', 'main']);
  git(fx, ['switch', '-c', 'feat/widget']);
  fx.base = git(fx, ['rev-parse', 'HEAD']);
  return fx;
}

function commit(fx, name) {
  fs.writeFileSync(path.join(fx.root, name), `${name}\n`);
  git(fx, ['add', '--', name]);
  git(fx, ['commit', '--quiet', '-m', name]);
  return git(fx, ['rev-parse', 'HEAD']);
}

/** The real registry plus the fixture verbs that stand in for 017/018/019. */
function registryFor(fx) {
  const registry = buildRegistry();
  const base = { exitCodes: [0, 1, 2, 3, 4, 5], group: 'fixture', policyKeys: [], sideEffect: 'write' };
  const empty = { additionalProperties: false, properties: {}, type: 'object' };
  registry.register({
    ...base,
    handler: call =>
      handOff(call, {
        agents: [{ brief: { base: fx.base, branch: 'feat/widget' }, name: 'prose' }],
        role: 'pr-prose',
      }),
    inputSchema: empty,
    name: 'prose',
    outputSchema: empty,
    summary: 'fixture: a verb that needs the pr-prose agent',
  });
  registry.register({
    ...base,
    handler: call =>
      handOff(call, {
        agents: [{ brief: { base: fx.base, prId: 'pr-1' }, name: 'r1' }],
        role: 'reviewer',
      }),
    inputSchema: empty,
    name: 'review',
    outputSchema: empty,
    summary: 'fixture: a verb that needs the reviewer agent',
  });
  registry.register({
    ...base,
    handler: call =>
      resolveChoice(call, {
        flag: '--pr-backend',
        id: 'pr-backend',
        options: [{ value: 'gh' }, { value: 'manual' }],
        question: 'Which PR backend?',
      }),
    inputSchema: empty,
    name: 'choose',
    outputSchema: empty,
    summary: 'fixture: a verb that needs a decision',
  });
  return registry;
}

function run(fx, argv, env = {}) {
  return runMain(
    ['--run-id', RUN, ...argv],
    makeCtx({ cwd: fx.root, env: { ...fx.env, ...env }, now: NOW, registry: registryFor(fx) })
  );
}

function accept(fx, step, resultFile) {
  return run(fx, ['implement', 'accept', '--step', step, '--result-file', resultFile]);
}

/** Hand off to the pr-prose agent and return its manifest. */
function manifest(fx, verb = 'prose') {
  const out = run(fx, ['fixture', verb]);
  expect(out.envelope.status).toBe('NEEDS_AGENT');
  return out.envelope.data;
}

function writeResult(fx, outPath, body) {
  const file = path.join(fx.root, outPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

const proseResult = (agent, head, extra = {}) => ({
  head,
  howToRevert: 'git revert the squash commit',
  risk: 'low: one new verb',
  role: 'pr-prose',
  step: agent.step,
  ...extra,
});

const acceptedDir = fx => path.join(fx.root, '.ensemble', 'state', 'engine', RUN, 'accepted');

describe('a verb that needs judgement returns a manifest', () => {
  test('NEEDS_AGENT carries the agents, the HEAD sha and a next naming implement accept', () => {
    const fx = featureRepo();
    const head = git(fx, ['rev-parse', 'HEAD']);
    const out = run(fx, ['fixture', 'prose']);

    expect(out.exitCode).toBe(3);
    expect(out.envelope).toMatchObject({ ok: true, status: 'NEEDS_AGENT' });
    const { agents, baseHead } = out.envelope.data;
    expect(baseHead).toBe(head);
    expect(agents).toHaveLength(1);
    expect(Object.keys(agents[0]).sort()).toEqual(
      ['briefPath', 'deadlineAtIso', 'name', 'outPath', 'prompt', 'role', 'step'].sort()
    );
    expect(agents[0].outPath).toBe(`.ensemble/state/engine/${RUN}/results/pr-prose--prose.json`);
    expect(agents[0].deadlineAtIso).toBe(new Date((NOW + 900) * 1000).toISOString());
    expect(out.envelope.next.verb).toBe('implement accept');
    expect(out.envelope.next.calls[0].args).toEqual([
      '--run-id', RUN, 'implement', 'accept', '--step', 'pr-prose--prose', '--result-file', agents[0].outPath,
    ]);

    // The brief the agent will read is on disk and names the head it was written against.
    const brief = JSON.parse(fs.readFileSync(path.join(fx.root, agents[0].briefPath), 'utf8'));
    expect(brief).toMatchObject({ branch: 'feat/widget', head, role: 'pr-prose', step: 'pr-prose--prose' });
    // The hand-off wrote state only under the self-ignoring state directory.
    expect(git(fx, ['status', '--porcelain'])).toBe('');
  });

  test('the same input twice gives the same manifest', () => {
    const fx = featureRepo();
    expect(run(fx, ['fixture', 'prose']).stdout).toBe(run(fx, ['fixture', 'prose']).stdout);
  });

  test('a hand-off without --run-id is INVALID_INPUT', () => {
    const fx = featureRepo();
    const out = runMain(['fixture', 'prose'], makeCtx({ cwd: fx.root, env: fx.env, now: NOW, registry: registryFor(fx) }));
    expect(out.envelope).toMatchObject({ error: { code: 'RUN_ID_REQUIRED' }, status: 'INVALID_INPUT' });
  });
});

describe('implement accept records only a valid, current, still-applicable result', () => {
  test('a schema-valid result under the results directory is recorded', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, proseResult(agent, head));

    const out = accept(fx, agent.step, agent.outPath);
    expect(out.exitCode).toBe(0);
    expect(out.envelope.status).toBe('OK');
    expectMatchesOutputSchema(buildRegistry().get('implement', 'accept'), out.envelope);
    expect(out.envelope.data).toMatchObject({ ACCEPTED: true, HEAD: head, ROLE: 'pr-prose', STEP: agent.step });

    const recorded = JSON.parse(fs.readFileSync(path.join(fx.root, out.envelope.data.RECORD_PATH), 'utf8'));
    expect(recorded.result.risk).toBe('low: one new verb');
    expect(recorded.head).toBe(head);
    // Accepting the same bytes again is the same answer, not a second record.
    expect(accept(fx, agent.step, agent.outPath).stdout).toBe(out.stdout);
  });

  test('a different result for an already accepted step is REFUSED, not overwritten', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, proseResult(agent, head));
    expect(accept(fx, agent.step, agent.outPath).exitCode).toBe(0);
    writeResult(fx, agent.outPath, proseResult(agent, head, { risk: 'changed my mind' }));

    const out = accept(fx, agent.step, agent.outPath);
    expect(out.envelope).toMatchObject({ error: { code: 'ALREADY_ACCEPTED' }, status: 'REFUSED' });
    const record = fs.readdirSync(acceptedDir(fx)).map(f => fs.readFileSync(path.join(acceptedDir(fx), f), 'utf8'));
    expect(record.join('')).toContain('low: one new verb');
  });

  test.each([
    ['an unknown key', agent => ({ extra: 'x' }), 'extra'],
    ['a missing field', () => ({ risk: undefined }), 'risk'],
    ['a wrong type', () => ({ risk: 7 }), 'risk'],
  ])('a result with %s is INVALID_INPUT and nothing is recorded', (_label, mutate, field) => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, proseResult(agent, head, mutate(agent)));

    const out = accept(fx, agent.step, agent.outPath);
    expect(out.exitCode).toBe(2);
    expect(out.envelope).toMatchObject({ error: { code: 'SCHEMA_VIOLATION' }, status: 'INVALID_INPUT' });
    expect(out.envelope.error.message).toContain(field);
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('a file that is not JSON, or answers a different step, is INVALID_INPUT', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, '{"risk": ');
    expect(accept(fx, agent.step, agent.outPath).envelope.error.code).toBe('INVALID_JSON');

    writeResult(fx, agent.outPath, proseResult(agent, head, { step: 'pr-prose--other' }));
    expect(accept(fx, agent.step, agent.outPath).envelope.error.code).toBe('STEP_MISMATCH');
    expect(accept(fx, 'nonsense', agent.outPath).envelope.error.code).toBe('UNKNOWN_STEP');
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('an oversized result is refused without being parsed', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, proseResult(agent, head, { risk: 'x'.repeat(MAX_RESULT_BYTES) }));

    const out = accept(fx, agent.step, agent.outPath);
    expect(out.envelope).toMatchObject({ error: { code: 'RESULT_TOO_LARGE' }, status: 'INVALID_INPUT' });
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('a result produced before HEAD moved is REFUSED as stale', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const old = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, proseResult(agent, old));
    const moved = commit(fx, 'later.txt');

    const out = accept(fx, agent.step, agent.outPath);
    expect(out.exitCode).toBe(1);
    expect(out.envelope).toMatchObject({ error: { code: 'STALE_RESULT' }, status: 'REFUSED' });
    expect(out.envelope.error.details).toEqual({ head: moved, resultHead: old });
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('a result path outside the results directory is PATH_ESCAPE', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    const body = proseResult(agent, head);
    writeResult(fx, 'elsewhere.json', body);
    writeResult(fx, `.ensemble/state/engine/${RUN}/briefs/stray.json`, body);
    fs.mkdirSync(path.join(fx.root, '..', 'outside'), { recursive: true });
    const outside = path.join(fx.root, '..', 'outside', 'r.json');
    fs.writeFileSync(outside, JSON.stringify(body));
    // A symlink that sits in the results directory but leads out of it.
    fs.symlinkSync(path.join(fx.root, 'elsewhere.json'), path.join(fx.root, '.ensemble/state/engine', RUN, 'results', 'link.json'));

    for (const candidate of [
      'elsewhere.json',
      `.ensemble/state/engine/${RUN}/briefs/stray.json`,
      path.relative(fx.root, outside),
      `.ensemble/state/engine/${RUN}/results/link.json`,
      `.ensemble/state/engine/${RUN}/results/../briefs/stray.json`,
    ]) {
      const out = accept(fx, agent.step, candidate);
      expect({ candidate, code: out.envelope.error && out.envelope.error.code, status: out.envelope.status }).toEqual({
        candidate,
        code: 'PATH_ESCAPE',
        status: 'INVALID_INPUT',
      });
    }
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('the precondition is re-derived: pr-prose off a feature branch is REFUSED even with a fresh result', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, proseResult(agent, head));
    // Same commit, so the result is not stale -- only the live branch changed.
    git(fx, ['switch', 'main']);

    const out = accept(fx, agent.step, agent.outPath);
    expect(out.envelope).toMatchObject({ error: { code: 'PRECONDITION_NOT_MET' }, status: 'REFUSED' });
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('the reviewer precondition needs a real diff: base equal to HEAD is REFUSED, a real ancestor is accepted', () => {
    const fx = featureRepo();
    commit(fx, 'one.txt');
    const [agent] = manifest(fx, 'review').agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    const result = (base) => ({ base, findings: [], head, role: 'reviewer', step: agent.step, verdict: 'pass' });

    writeResult(fx, agent.outPath, result(head));
    expect(accept(fx, agent.step, agent.outPath).envelope).toMatchObject({
      error: { code: 'PRECONDITION_NOT_MET' },
      status: 'REFUSED',
    });
    writeResult(fx, agent.outPath, result(fx.base));
    expect(accept(fx, agent.step, agent.outPath).envelope.status).toBe('OK');
  });
});

describe('a decision in a non-interactive run', () => {
  test('interactive: NEEDS_CHOICE with the options and the flag', () => {
    const fx = featureRepo();
    const out = run(fx, ['fixture', 'choose']);
    expect(out.exitCode).toBe(4);
    expect(out.envelope.status).toBe('NEEDS_CHOICE');
    expect(out.envelope.data.CHOICE).toMatchObject({ flag: '--pr-backend', id: 'pr-backend' });
  });

  test.each([
    ['--non-interactive', ['--non-interactive'], {}],
    ['FOREMAN_TASK_TITLE', [], { FOREMAN_TASK_TITLE: 'task' }],
  ])('%s: REFUSED naming the exact flag, never a prompt', (_label, flags, env) => {
    const fx = featureRepo();
    const out = run(fx, [...flags, 'fixture', 'choose'], env);
    expect(out.exitCode).toBe(1);
    expect(out.envelope).toMatchObject({ error: { code: 'CHOICE_REQUIRED' }, status: 'REFUSED' });
    expect(out.envelope.error.message).toContain('--pr-backend <gh|manual>');
  });
});

describe('roles are published', () => {
  test('--describe lists builder-wave, reviewer and pr-prose with both schemas', () => {
    const { envelope } = runMain(['--describe'], makeCtx());
    const roles = Object.fromEntries(envelope.data.roles.map(role => [role.name, role]));
    expect(Object.keys(roles).sort()).toEqual(['builder-wave', 'pr-prose', 'reviewer']);
    for (const role of Object.values(roles)) {
      expect(role.briefSchema.additionalProperties).toBe(false);
      expect(role.resultSchema.additionalProperties).toBe(false);
    }
    expect(envelope.data.verbs.map(v => `${v.group} ${v.name}`)).toContain('implement accept');
  });
});
