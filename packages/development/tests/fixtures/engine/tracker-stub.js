'use strict';

/**
 * TRD-011-TEST (TRD-2026-d571763f): a STATEFUL tracker stub for `ensemble implement scaffold`.
 *
 * `tests/helpers/engine-repo.js`'s `fixtureTracker` is deliberately read-only: it refuses every
 * mutating call. Scaffolding is a write flow, so its scenarios need a tracker that actually
 * remembers what was created -- otherwise "re-run creates nothing" and "resume after a crash"
 * could not be observed at all.
 *
 * The stub decides nothing the verb is supposed to decide. It stores what it is told, hands
 * back ids, and keeps a call log; which beads to create, in which order, and which edges to
 * wire stays entirely with the engine. `control.failCreateAt` is the one lever a scenario
 * pulls, and it only makes a tool fail -- the engine's reaction is what is being pinned.
 *
 * The stub binary, its state and its log live OUTSIDE the project root (`${root}-tracker/`), so
 * `git status --porcelain` after a scaffold still proves the verb wrote nothing to the tree.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/** The stub's binary name -- deliberately neither `br` nor `kata`, whatever the adapter id is. */
const STUB_BIN = 'fixture-tracker';

/** Every subcommand the stub answers, and therefore every entry of the manifest allowlist. */
const SUBCOMMANDS = Object.freeze([
  '--version',
  'list',
  'find-by-key',
  'create',
  'create-detailed',
  'dep-add',
  'dep-remove',
  'label',
  'sync',
  'comment',
  'close',
]);

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function issueList(state) {
  return Array.isArray(state.issues) ? state.issues : [];
}

/**
 * The stub's whole command surface. Exported so the generated binary is four lines and the
 * behaviour under test stays reviewable in one place.
 *
 * @param {string[]} argv the binary's own arguments
 * @param {{kata: boolean, log: string, state: string}} options absolute paths, baked into the binary
 * @param {{stdout: {write: Function}, stderr: {write: Function}}} [streams]
 * @returns {number} the process exit code
 */
function runStubCli(argv, options, streams = process) {
  const { kata = false, log, state: statePath } = options;
  const out = text => streams.stdout.write(text);
  const err = text => streams.stderr.write(text);
  fs.appendFileSync(log, `${JSON.stringify(argv)}\n`);

  const verb = argv[0];
  if (verb === '--version') {
    out(`${STUB_BIN} 1.0.0\n`);
    return 0;
  }

  const state = readState(statePath);

  if (verb === 'list') {
    // A kata workspace lists open work only; beads lists everything. The difference is what
    // makes the external-key lookup necessary on the kata path.
    const issues = kata ? issueList(state).filter(i => i.status !== 'closed') : issueList(state);
    out(`${JSON.stringify({ issues, total: issues.length })}\n`);
    return 0;
  }

  if (verb === 'find-by-key') {
    // The category contract says this capability lists the whole workspace and the caller
    // selects by key, closed items included.
    const issues = issueList(state);
    out(`${JSON.stringify({ issues, total: issues.length })}\n`);
    return 0;
  }

  fs.appendFileSync(log, `MUTATION ${JSON.stringify(argv)}\n`);

  if (verb === 'create' || verb === 'create-detailed') {
    const attempt = (state.creates || 0) + 1;
    state.creates = attempt;
    const control = state.control || {};
    if (control.failCreateAt === attempt) {
      delete control.failCreateAt;
      state.control = control;
      writeState(statePath, state);
      err(`stub ${STUB_BIN}: create failed\n`);
      return 1;
    }
    const id = `st-${(state.seq || 0) + 1}`;
    state.seq = (state.seq || 0) + 1;
    const detailed = verb === 'create-detailed';
    state.issues = issueList(state).concat({
      id,
      title: argv[1],
      type: argv[2],
      description: argv[3],
      status: 'open',
      labels: detailed ? String(argv[4] || '').split(',').filter(part => part.length > 0) : [],
      priority: detailed ? argv[5] : null,
      external_ref: detailed ? argv[6] : null,
      dependencies: [],
    });
    writeState(statePath, state);
    out(`${control.emptyId === true ? '{}' : JSON.stringify({ id })}\n`);
    return 0;
  }

  if (verb === 'dep-add' || verb === 'dep-remove') {
    const [, id, dependsOnId, type] = argv;
    const blocked = issueList(state).find(issue => issue.id === id);
    if (!blocked) {
      err(`stub ${STUB_BIN}: no such issue '${id}'\n`);
      return 1;
    }
    blocked.dependencies = Array.isArray(blocked.dependencies) ? blocked.dependencies : [];
    const at = blocked.dependencies.findIndex(dep => dep && dep.id === dependsOnId);
    if (verb === 'dep-add') {
      if (at === -1) blocked.dependencies.push({ id: dependsOnId, type: type || 'blocks' });
      writeState(statePath, state);
      out(
        `${JSON.stringify({
          status: 'ok',
          issue_id: id,
          depends_on_id: dependsOnId,
          type: type || 'blocks',
          action: at === -1 ? 'added' : 'exists',
        })}\n`
      );
      return 0;
    }
    if (at === -1) {
      err(`stub ${STUB_BIN}: dependency not found\n`);
      return 1;
    }
    blocked.dependencies.splice(at, 1);
    writeState(statePath, state);
    out(`${JSON.stringify({ status: 'ok', issue_id: id, depends_on_id: dependsOnId })}\n`);
    return 0;
  }

  if (verb === 'label') {
    const ids = String(argv[1] || '').split(',').filter(part => part.length > 0);
    const labels = String(argv[2] || '').split(',').filter(part => part.length > 0);
    for (const issue of issueList(state)) {
      if (!ids.includes(issue.id)) continue;
      const have = Array.isArray(issue.labels) ? issue.labels : [];
      issue.labels = [...new Set([...have, ...labels])];
    }
    writeState(statePath, state);
    out(`${JSON.stringify({ ids, labels })}\n`);
    return 0;
  }

  if (verb === 'sync') {
    state.synced = (state.synced || 0) + 1;
    writeState(statePath, state);
    out(`${JSON.stringify({ status: 'ok' })}\n`);
    return 0;
  }

  if (verb === 'comment' || verb === 'close') {
    out(`${JSON.stringify({ id: argv[1] || null, status: verb === 'close' ? 'closed' : 'open' })}\n`);
    return 0;
  }

  err(`stub ${STUB_BIN}: unexpected ${JSON.stringify(argv)}\n`);
  return 1;
}

/**
 * The capability table the manifest declares. A capability switched off by `declare` is simply
 * absent, which is exactly how a real adapter that cannot do it looks to the runner: an
 * optional capability with a documented fallback answers `unavailable`, one without answers
 * `NOT_ALLOWED` "is not declared by adapter". Both shapes are degradations the verb must handle.
 *
 * Argv shapes follow `packages/development/skills/adapter-tracker-beads/adapter.yaml`
 * (`tracker.create` :147-154, `tracker.create-detailed` :163-185, `tracker.dep-add` /
 * `tracker.dep-remove` :347-363). Only the two create capabilities declare `parse`: the
 * collection answers (`tracker.list`, `tracker.find-by-key`, `tracker.label`, `tracker.sync`)
 * are handed to the caller as raw text, exactly as the beads adapter hands them over.
 */
function capabilityTable(declare, createParse) {
  const on = key => declare[key] !== false;
  const idParse = { format: 'json', root: '$', map: { id: '$.id' } };
  const table = {
    'tracker.list': { run: [STUB_BIN, 'list'] },
    'tracker.create': {
      run: [STUB_BIN, 'create', '${title}', '${type}', '${description}'],
      ...(createParse ? { parse: idParse } : {}),
    },
    'tracker.comment': { run: [STUB_BIN, 'comment', '${id}', '${text}'], parse: idParse },
    'tracker.close': { run: [STUB_BIN, 'close', '${id}'], parse: idParse },
  };
  if (on('findByKey')) table['tracker.find-by-key'] = { run: [STUB_BIN, 'find-by-key', '${key}'] };
  if (on('createDetailed')) {
    table['tracker.create-detailed'] = {
      run: [
        STUB_BIN,
        'create-detailed',
        '${title}',
        '${type}',
        '${description}',
        '${labels}',
        '${priority}',
        '${externalKey}',
      ],
      parse: idParse,
    };
  }
  if (on('depAdd')) {
    table['tracker.dep-add'] = {
      run: [STUB_BIN, 'dep-add', '${id}', '${dependsOnId}', '${type}'],
    };
  }
  if (on('depRemove')) {
    table['tracker.dep-remove'] = { run: [STUB_BIN, 'dep-remove', '${id}', '${dependsOnId}'] };
  }
  if (on('label')) table['tracker.label'] = { run: [STUB_BIN, 'label', '${ids}', '${labels}'] };
  if (on('sync')) table['tracker.sync'] = { run: [STUB_BIN, 'sync'] };
  return table;
}

/**
 * Install the stateful stub tracker in a fixture project: the binary on the fixture `PATH`, an
 * installed-origin adapter manifest under `<root>/packages/fixture-pkg/skills/`, and
 * `.ensemble/toolchain.yaml` naming it. Call it BEFORE `initRepo` so the committed tree is clean.
 *
 * @param {string} root the project root
 * @param {{adapter?: string, createParse?: boolean, declare?: object, issues?: object[]}} [options]
 *   `adapter: 'kata'` makes the manifest claim the `kata` id, which shadows the library's own
 *   kata adapter by discovery order and switches the verb onto its kata path.
 * @returns {object} the handle described in this module's tests
 */
function createTrackerStub(root, options = {}) {
  const { adapter = 'fixture-tracker', createParse = true, declare = {}, issues = [] } = options;
  const kata = adapter === 'kata';

  const dataDir = `${root}-tracker`;
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  const log = path.join(dataDir, 'calls.log');
  writeState(statePath, {
    seq: issues.length,
    creates: 0,
    issues: issues.map(issue => ({ dependencies: [], labels: [], status: 'open', ...issue })),
    control: createParse ? {} : { emptyId: true },
  });
  fs.writeFileSync(log, '');

  const binDir = path.join(root, 'fixture-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const source = [
    '#!/usr/bin/env node',
    "'use strict';",
    `const { runStubCli } = require(${JSON.stringify(__filename)});`,
    `process.exit(runStubCli(process.argv.slice(2), ${JSON.stringify({ kata, log, state: statePath })}));`,
  ].join('\n');
  const bin = path.join(binDir, STUB_BIN);
  fs.writeFileSync(bin, `${source}\n`, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);

  const adapterDir = path.join(root, 'packages', 'fixture-pkg', 'skills', adapter);
  fs.mkdirSync(adapterDir, { recursive: true });
  fs.writeFileSync(
    path.join(adapterDir, 'adapter.yaml'),
    yaml.dump({
      adapter,
      version: '1.0.0',
      categories: ['tracker'],
      contract: { tracker: '1.0' },
      binaries: [STUB_BIN],
      allowlist: [{ bin: STUB_BIN, sub: [...SUBCOMMANDS] }],
      env: [],
      health: [{ id: 'tracker-version', run: [STUB_BIN, '--version'], timeoutMs: 5000 }],
      detect: [],
      capabilities: capabilityTable(declare, createParse),
    })
  );
  fs.writeFileSync(path.join(adapterDir, 'SKILL.md'), `# ${adapter}\n`);

  const configFile = path.join(root, '.ensemble', 'toolchain.yaml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `tracker: ${adapter}\n`);

  const read = () => readState(statePath);
  return {
    adapter,
    adapterDir,
    log,
    root,
    state: statePath,
    /** Every issue the stub holds, in creation order. */
    issues: () => issueList(read()),
    /** The one issue whose title starts with `prefix`, or null. */
    byPrefix: prefix => issueList(read()).find(i => String(i.title).startsWith(prefix)) || null,
    /** Every dependency edge, as bead ids. */
    edges: () =>
      issueList(read()).flatMap(issue =>
        (issue.dependencies || []).map(dep => ({ blocked: issue.id, blocker: dep.id }))
      ),
    /** Every argv the stub was handed. */
    calls: () =>
      fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('['))
        .map(line => JSON.parse(line)),
    /** Every argv that asked the stub to change something. */
    mutations: () =>
      fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('MUTATION '))
        .map(line => JSON.parse(line.slice('MUTATION '.length))),
    /** A digest of the tracker's whole state, so "nothing changed" is provable. */
    hash: () => crypto.createHash('sha256').update(fs.readFileSync(statePath)).digest('hex'),
    /** Make the `n`-th create of this workspace fail once, as a crash would. */
    failCreateAt: n => {
      const state = read();
      state.control = { ...(state.control || {}), failCreateAt: n };
      writeState(statePath, state);
    },
    /** Wire an edge behind the engine's back, so a stale one can exist before a run. */
    seedEdge: (blockedId, blockerId) => {
      const state = read();
      const blocked = issueList(state).find(issue => issue.id === blockedId);
      if (!blocked) throw new Error(`seedEdge: no issue '${blockedId}'`);
      blocked.dependencies = Array.isArray(blocked.dependencies) ? blocked.dependencies : [];
      if (!blocked.dependencies.some(dep => dep.id === blockerId)) {
        blocked.dependencies.push({ id: blockerId, type: 'blocks' });
      }
      writeState(statePath, state);
    },
    /** Remove an edge behind the engine's back. */
    dropEdge: (blockedId, blockerId) => {
      const state = read();
      const blocked = issueList(state).find(issue => issue.id === blockedId);
      if (!blocked) throw new Error(`dropEdge: no issue '${blockedId}'`);
      blocked.dependencies = (blocked.dependencies || []).filter(dep => dep.id !== blockerId);
      writeState(statePath, state);
    },
    setDescription: (id, text) => {
      const state = read();
      const issue = issueList(state).find(candidate => candidate.id === id);
      if (!issue) throw new Error(`setDescription: no issue '${id}'`);
      issue.description = text;
      writeState(statePath, state);
    },
    setStatus: (id, status) => {
      const state = read();
      const issue = issueList(state).find(candidate => candidate.id === id);
      if (!issue) throw new Error(`setStatus: no issue '${id}'`);
      issue.status = status;
      writeState(statePath, state);
    },
  };
}

/**
 * A TRD whose Master Task List is big enough to show plan order, two phases and a synthesized
 * test, and small enough that a scaffold stays a few dozen child processes (12 beads).
 *
 * @param {{interPhaseDepends?: boolean, slug?: string, synth?: boolean}} [options]
 *   `synth` adds one loose nested checklist line under TRD-001, which the parser turns into the
 *   synthesized test `TRD-001-TEST-S1`; `interPhaseDepends` makes the first task of phase 2
 *   genuinely depend on the last task of phase 1, which is the one case the stale-edge repair
 *   must leave alone.
 * @returns {string} the TRD markdown
 */
function fixtureTrd(options = {}) {
  const { interPhaseDepends = false, synth = true } = options;
  const lines = [
    '---',
    'status: In Progress',
    'design_readiness_score: 4.5',
    '---',
    '',
    '# TRD: Widget Engine',
    '',
    'The widget engine stores and deletes widgets.',
    '',
    '## Master Task List',
    '',
    '### Phase 1: Core',
    '',
    '**Shippable State:** widgets can be stored',
    '',
    '- [ ] **TRD-001**: Create widget storage (2h)',
    '  - Implementation AC:',
    '    - [ ] Storage accepts widgets',
  ];
  if (synth) lines.push('  - [ ] Verify the storage test suite covers rejection');
  lines.push(
    '',
    '- [ ] **TRD-001-TEST**: Widget storage tests (1h) [depends: TRD-001]',
    '  - Test AC:',
    '    - [ ] Scenario: storing a widget keeps it',
    '',
    '- [ ] **TRD-002**: Read widget storage (2h) [depends: TRD-001]',
    '  - Implementation AC:',
    '    - [ ] Storage returns widgets',
    '',
    '- [ ] **TRD-002-TEST**: Widget read tests (1h) [depends: TRD-002]',
    '  - Test AC:',
    '    - [ ] Scenario: reading a stored widget returns it',
    '',
    '### Phase 2: Deletion',
    '',
    '**Shippable State:** widgets can be deleted',
    '',
    `- [ ] **TRD-003**: Delete widget storage (2h) [depends: ${
      interPhaseDepends ? 'TRD-002-TEST' : 'TRD-002'
    }]`,
    '  - Implementation AC:',
    '    - [ ] Storage deletes widgets',
    '',
    '- [ ] **TRD-003-TEST**: Widget deletion tests (1h) [depends: TRD-003]',
    '  - Test AC:',
    '    - [ ] Scenario: deleting a widget removes it',
    '',
    '- [ ] **TRD-004**: Report widget storage (2h) [depends: TRD-003]',
    '  - Implementation AC:',
    '    - [ ] Storage reports widget counts',
    '',
    '- [ ] **TRD-004-TEST**: Widget report tests (1h) [depends: TRD-004]',
    '  - Test AC:',
    '    - [ ] Scenario: the report counts stored widgets',
    ''
  );
  return lines.join('\n');
}

module.exports = {
  STUB_BIN,
  SUBCOMMANDS,
  createTrackerStub,
  fixtureTrd,
  runStubCli,
};
