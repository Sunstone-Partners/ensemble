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
const { initRepo, makeRepo, writeToolchainYaml } = require('./helpers/engine-repo');
const { createTrackerStub } = require('./fixtures/engine/tracker-stub');

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
        agents: [{ brief: { base: fx.reviewBase || fx.base, prId: 'pr-1' }, name: 'r1' }],
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
      handOff(call, {
        agents: [{ brief: { beads: fx.dispatchBeads, instructions: 'build the wave' }, name: 'wave' }],
        role: 'builder-wave',
      }),
    inputSchema: empty,
    name: 'build',
    outputSchema: empty,
    summary: 'fixture: a verb that needs the builder-wave agent',
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

  test.each(['review', 'build'])('%s without delegated completion still rejects HEAD movement', verb => {
    const fx = featureRepo();
    fx.dispatchBeads = ['task-1'];
    const [agent] = manifest(fx, verb).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    const moved = commit(fx, 'later.txt');
    const body = verb === 'review'
      ? { role: 'reviewer', head, step: agent.step, base: fx.base, findings: [], verdict: 'pass' }
      : { role: 'builder-wave', head, ending_head: moved, step: agent.step, beads: ['task-1'], status: 'done', summary: 'built' };
    writeResult(fx, agent.outPath, body);
    const out = accept(fx, agent.step, agent.outPath);
    expect(out.envelope.status).toBe('REFUSED');
    expect(out.envelope.error.code).toBe('STALE_RESULT');
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
    expect(out.envelope.error.details).toEqual({ dispatchedHead: old, head: moved });
    expect(moved).not.toBe(old);
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

  test('a result cannot claim the current HEAD for an older dispatch', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const moved = commit(fx, 'later.txt');
    writeResult(fx, agent.outPath, proseResult(agent, moved));

    const out = accept(fx, agent.step, agent.outPath);
    expect(out.envelope).toMatchObject({ error: { code: 'STALE_RESULT' }, status: 'REFUSED' });
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('a result for a step the engine never dispatched is REFUSED', () => {
    const fx = featureRepo();
    const head = git(fx, ['rev-parse', 'HEAD']);
    const agent = { step: 'pr-prose--ghost' };
    const outPath = `.ensemble/state/engine/${RUN}/results/pr-prose--ghost.json`;
    writeResult(fx, outPath, proseResult(agent, head));

    const out = accept(fx, agent.step, outPath);
    expect(out.envelope).toMatchObject({ error: { code: 'NO_DISPATCH' }, status: 'REFUSED' });
    expect(fs.existsSync(acceptedDir(fx))).toBe(false);
  });

  test('pr-prose is bound to the dispatched branch', () => {
    const fx = featureRepo();
    const [agent] = manifest(fx).agents;
    const head = git(fx, ['rev-parse', 'HEAD']);
    writeResult(fx, agent.outPath, proseResult(agent, head));
    git(fx, ['switch', '-c', 'feat/other']);

    expect(accept(fx, agent.step, agent.outPath).envelope.error.code).toBe('PRECONDITION_NOT_MET');
  });

  describe('state directories never lead outside the project', () => {
    function outsideDir(fx, name) {
      const dir = path.join(path.dirname(fx.root), `${path.basename(fx.root)}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    const listing = dir => fs.readdirSync(dir).sort();

    test('an accepted directory that is a symlink out of the tree is refused and the target stays untouched', () => {
      const fx = featureRepo();
      const [agent] = manifest(fx).agents;
      const head = git(fx, ['rev-parse', 'HEAD']);
      writeResult(fx, agent.outPath, proseResult(agent, head));
      const outside = outsideDir(fx, 'accepted');
      fs.symlinkSync(outside, acceptedDir(fx));

      const out = accept(fx, agent.step, agent.outPath);
      expect(out.envelope).toMatchObject({ error: { code: 'PATH_ESCAPE' }, status: 'INVALID_INPUT' });
      expect(listing(outside)).toEqual([]);
    });

    test('a symlinked engine state directory stops a hand-off before anything is created', () => {
      const fx = featureRepo();
      const outside = outsideDir(fx, 'engine');
      fs.mkdirSync(path.join(fx.root, '.ensemble', 'state'), { recursive: true });
      fs.symlinkSync(outside, path.join(fx.root, '.ensemble', 'state', 'engine'));

      const out = run(fx, ['fixture', 'prose']);
      expect(out.envelope).toMatchObject({ error: { code: 'PATH_ESCAPE' }, status: 'INVALID_INPUT' });
      expect(listing(outside)).toEqual([]);
    });

    test('a symlink planted at the accepted file is never written through', () => {
      const fx = featureRepo();
      const [agent] = manifest(fx).agents;
      const head = git(fx, ['rev-parse', 'HEAD']);
      writeResult(fx, agent.outPath, proseResult(agent, head));
      const outside = outsideDir(fx, 'victim');
      const victim = path.join(outside, 'victim.json');
      fs.writeFileSync(victim, 'untouched');
      fs.mkdirSync(acceptedDir(fx), { recursive: true });
      fs.symlinkSync(victim, path.join(acceptedDir(fx), `${agent.step}.json`));

      const out = accept(fx, agent.step, agent.outPath);
      expect(out.envelope.status).toBe('REFUSED');
      expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
      expect(listing(outside)).toEqual(['victim.json']);
    });

    test('a brief that is a symlink out of the briefs directory is not trusted', () => {
      const fx = featureRepo();
      const [agent] = manifest(fx).agents;
      const head = git(fx, ['rev-parse', 'HEAD']);
      writeResult(fx, agent.outPath, proseResult(agent, head));
      const briefFile = path.join(fx.root, agent.briefPath);
      const copy = path.join(outsideDir(fx, 'brief'), 'brief.json');
      fs.copyFileSync(briefFile, copy);
      fs.rmSync(briefFile);
      fs.symlinkSync(copy, briefFile);

      expect(accept(fx, agent.step, agent.outPath).envelope).toMatchObject({
        error: { code: 'NO_DISPATCH' },
        status: 'REFUSED',
      });
    });
  });

  describe('reviewer', () => {
    const result = (agent, head, base) => ({ base, findings: [], head, role: 'reviewer', step: agent.step, verdict: 'pass' });

    test('the dispatched base must be a strict ancestor of HEAD; a real ancestor is accepted', () => {
      const fx = featureRepo();
      commit(fx, 'one.txt');
      const head = git(fx, ['rev-parse', 'HEAD']);

      fx.reviewBase = head; // dispatched with nothing to review
      let [agent] = manifest(fx, 'review').agents;
      writeResult(fx, agent.outPath, result(agent, head, head));
      expect(accept(fx, agent.step, agent.outPath).envelope).toMatchObject({
        error: { code: 'PRECONDITION_NOT_MET' },
        status: 'REFUSED',
      });

      fx.reviewBase = fx.base;
      [agent] = manifest(fx, 'review').agents;
      writeResult(fx, agent.outPath, result(agent, head, fx.base));
      expect(accept(fx, agent.step, agent.outPath).envelope.status).toBe('OK');
    });

    test('a base that is not a commit is a definitive REFUSED, but a git outage stays UNAVAILABLE', () => {
      const fx = featureRepo();
      commit(fx, 'one.txt');
      const head = git(fx, ['rev-parse', 'HEAD']);
      fx.reviewBase = 'f'.repeat(40);
      const [agent] = manifest(fx, 'review').agents;
      writeResult(fx, agent.outPath, result(agent, head, 'f'.repeat(40)));
      expect(accept(fx, agent.step, agent.outPath).envelope).toMatchObject({
        error: { code: 'PRECONDITION_NOT_MET' },
        status: 'REFUSED',
      });

      // Same result, but git dies with a fatal error while resolving the base: not "no such commit".
      fx.reviewBase = fx.base;
      const [real] = manifest(fx, 'review').agents;
      writeResult(fx, real.outPath, result(real, head, fx.base));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { env: fx.env, encoding: 'utf8' }).trim();
      const shim = path.join(path.dirname(fx.root), `${path.basename(fx.root)}-gitshim`);
      fs.mkdirSync(shim, { recursive: true });
      fs.writeFileSync(
        path.join(shim, 'git'),
        `#!/bin/sh\ncase "$*" in *--verify*) echo 'fatal: object database unreadable' >&2; exit 128;; esac\nexec ${realGit} "$@"\n`,
        { mode: 0o755 }
      );
      const out = run(fx, ['implement', 'accept', '--step', real.step, '--result-file', real.outPath], {
        PATH: `${shim}:${fx.env.PATH}`,
      });
      expect(out.envelope.status).toBe('UNAVAILABLE');
      expect(out.envelope.error.code).toBe('GIT_UNAVAILABLE');
    });

    test('a result cannot substitute a different base than was dispatched', () => {
      const fx = featureRepo();
      commit(fx, 'one.txt');
      const head = git(fx, ['rev-parse', 'HEAD']);
      const [agent] = manifest(fx, 'review').agents;
      // `head` is a valid ancestor-or-equal commit, but it is not the base that was dispatched.
      const middle = commit(fx, 'two.txt');
      git(fx, ['reset', '--quiet', '--hard', head]);
      writeResult(fx, agent.outPath, result(agent, head, middle));

      expect(accept(fx, agent.step, agent.outPath).envelope).toMatchObject({
        error: { code: 'BINDING_MISMATCH' },
        status: 'REFUSED',
      });
      expect(fs.existsSync(acceptedDir(fx))).toBe(false);
    });
  });

  describe('builder-wave', () => {
    function builderRepo() {
      const fx = makeRepo({ files: { 'README.md': 'widget\n' }, init: false });
      fx.tracker = createTrackerStub(fx.root, {
        issues: [
          { id: 'bd-1', status: 'open', title: '[trd:w] TRD-001: one' },
          { id: 'bd-2', status: 'open', title: '[trd:w] TRD-002: two' },
          { id: 'bd-9', status: 'closed', title: '[trd:w] TRD-009: unrelated' },
        ],
      });
      initRepo(fx, {});
      git(fx, ['branch', '-M', 'main']);
      const pre = runMain(
        ['tool', 'preflight', '--require', 'tracker.list', '--run-id', RUN],
        makeCtx({ cwd: fx.root, env: fx.env })
      );
      expect(pre.exitCode).toBe(0);
      fx.dispatchBeads = ['bd-1', 'bd-2'];
      return fx;
    }
    const result = (agent, head, beads, status = 'done') => ({
      beads, head, role: 'builder-wave', status, step: agent.step, summary: 'built',
    });
    const dispatch = fx => {
      const { agents, baseHead } = manifest(fx, 'build');
      return { agent: agents[0], head: baseHead };
    };

    test('done with every dispatched bead closed in the tracker is recorded', () => {
      const fx = builderRepo();
      const { agent, head } = dispatch(fx);
      fx.tracker.setStatus('bd-1', 'closed');
      fx.tracker.setStatus('bd-2', 'closed');
      writeResult(fx, agent.outPath, result(agent, head, ['bd-2', 'bd-1']));
      expect(accept(fx, agent.step, agent.outPath).envelope.status).toBe('OK');
    });

    test('a dispatched bead still open in the tracker is REFUSED even though the result says done', () => {
      const fx = builderRepo();
      const { agent, head } = dispatch(fx);
      fx.tracker.setStatus('bd-1', 'closed');
      writeResult(fx, agent.outPath, result(agent, head, ['bd-1', 'bd-2']));

      const out = accept(fx, agent.step, agent.outPath);
      expect(out.envelope).toMatchObject({ error: { code: 'PRECONDITION_NOT_MET' }, status: 'REFUSED' });
      expect(out.envelope.error.details).toEqual({ beads: ['bd-2'] });
      expect(fs.existsSync(acceptedDir(fx))).toBe(false);
    });

    test.each([
      ['an empty bead list', []],
      ['an unrelated closed bead', ['bd-9']],
      ['a subset of the dispatched beads', ['bd-1']],
      ['the dispatched beads plus a stray one', ['bd-1', 'bd-2', 'bd-9']],
    ])('done with %s is REFUSED as a different job from the one dispatched', (_label, beads) => {
      const fx = builderRepo();
      const { agent, head } = dispatch(fx);
      for (const id of ['bd-1', 'bd-2']) fx.tracker.setStatus(id, 'closed');
      writeResult(fx, agent.outPath, result(agent, head, beads));

      const out = accept(fx, agent.step, agent.outPath);
      expect(out.envelope).toMatchObject({ error: { code: 'BINDING_MISMATCH' }, status: 'REFUSED' });
      expect(fs.existsSync(acceptedDir(fx))).toBe(false);
    });

    test('blocked may report a subset of the dispatched beads, never another bead', () => {
      const fx = builderRepo();
      const { agent, head } = dispatch(fx);
      writeResult(fx, agent.outPath, result(agent, head, ['bd-1'], 'blocked'));
      expect(accept(fx, agent.step, agent.outPath).envelope.status).toBe('OK');

      const fy = builderRepo();
      const second = dispatch(fy);
      writeResult(fy, second.agent.outPath, result(second.agent, second.head, ['bd-9'], 'blocked'));
      expect(accept(fy, second.agent.step, second.agent.outPath).envelope.error.code).toBe('BINDING_MISMATCH');
    });
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
