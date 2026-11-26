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
  'show',
  'find-by-key',
  'create',
  'create-detailed',
  'dep-add',
  'dep-remove',
  'label',
  'set-status',
  'sync',
  'comment',
  'comments',
  'close',
  'close-with-reason',
  'export',
]);

/** The test-runner stub's own subcommands; a separate allowlist, as a separate adapter. */
const TEST_RUNNER_SUBCOMMANDS = Object.freeze(['--version', 'test-run']);

/** The package-runner stub's own subcommands; again a separate adapter, again its own list. */
const PACKAGE_RUNNER_SUBCOMMANDS = Object.freeze(['--version', 'script']);

/** kata's server-side closure rules, which the engine must satisfy rather than work around. */
const KATA_REASON_MIN = 40;
const KATA_COMMIT_RE = /^[0-9a-f]{7,40}$/;

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
  const { kata = false, listDependencies = true, log, state: statePath } = options;
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
    // makes the external-key lookup necessary on the kata path. `--all` is kata's own opt-in
    // (the adapter's `filter: all` variant): a reader that needs closed work must ask for it.
    const all =
      kata && !argv.includes('--all')
        ? issueList(state).filter(i => i.status !== 'closed')
        : issueList(state);
    // `br list` carries a dependency COUNT, not the links themselves; a tracker whose rows do
    // carry them lets a reader skip the per-bead reads. Both shapes exist, so both are offered.
    // `listWithoutDependenciesFor` hides the links of some beads only, the shape a tracker whose
    // list answers for some rows and not for others has.
    const stripDependencies = ({ dependencies: _dependencies, ...rest }) => rest;
    const withoutFor = Array.isArray(state.control && state.control.listWithoutDependenciesFor)
      ? state.control.listWithoutDependenciesFor
      : [];
    const issues = listDependencies
      ? all.map(issue => (withoutFor.includes(issue.id) ? stripDependencies(issue) : issue))
      : all.map(stripDependencies);
    // `nullRowInList` makes the list carry a row that is not an issue at all.
    const nullRow = state.control && state.control.nullRowInList ? [null] : [];
    out(`${JSON.stringify({ issues: issues.concat(nullRow), total: issues.length })}\n`);
    return 0;
  }

  if (verb === 'show') {
    // One issue, whole: the only read that can carry an item's dependency links.
    const issue = issueList(state).find(candidate => candidate.id === argv[1]);
    if (!issue) {
      err(`stub ${STUB_BIN}: no such issue '${argv[1]}'\n`);
      return 1;
    }
    // `stripShowDependenciesFor` hides the links of some beads from this read only: the shape a
    // tracker whose show answers for some rows and not for others has.
    const hidden = Array.isArray(state.control && state.control.stripShowDependenciesFor) &&
      state.control.stripShowDependenciesFor.includes(issue.id);
    const { dependencies: _dependencies, ...rest } = issue;
    out(`${JSON.stringify(hidden ? rest : issue)}\n`);
    return 0;
  }

  if (verb === 'find-by-key') {
    // The category contract says this capability lists the whole workspace and the caller
    // selects by key, closed items included.
    const issues = issueList(state);
    out(`${JSON.stringify({ issues, total: issues.length })}\n`);
    return 0;
  }

  const read = runStubRead(verb, argv, { err, kata, out, state, statePath });
  if (read !== null) return read;

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
    const control = state.control || {};
    if (control.failLabel) {
      err(`stub ${STUB_BIN}: label failed\n`);
      return 1;
    }
    // `dropLabelFor` makes the call succeed and store nothing, which is what a tracker that
    // silently loses a label looks like to the caller -- the only way the verb's own
    // count-back check can be shown to fail.
    const dropped = Array.isArray(control.dropLabelFor) ? control.dropLabelFor : [];
    for (const issue of issueList(state)) {
      if (!ids.includes(issue.id)) continue;
      if (dropped.includes(issue.id)) continue;
      const have = Array.isArray(issue.labels) ? issue.labels : [];
      issue.labels = [...new Set([...have, ...labels])];
    }
    writeState(statePath, state);
    out(`${JSON.stringify({ ids, labels })}\n`);
    return 0;
  }

  if (verb === 'set-status') {
    const issue = issueList(state).find(candidate => candidate.id === argv[1]);
    if (!issue) {
      err(`stub ${STUB_BIN}: no such issue '${argv[1]}'\n`);
      return 1;
    }
    issue.status = argv[2];
    writeState(statePath, state);
    out(`${JSON.stringify({ id: issue.id, status: issue.status })}\n`);
    return 0;
  }

  if (verb === 'sync') {
    state.synced = (state.synced || 0) + 1;
    writeState(statePath, state);
    out(`${JSON.stringify({ status: 'ok' })}\n`);
    return 0;
  }

  // TRD-013-TEST: the quality gate's own calls. `comment` and `close` are stateful here (they
  // were write-only before) because "the same phase twice adds no second comment and closes
  // nothing again" can only be observed against a tracker that remembers the first run.
  if (verb === 'comment') {
    const issue = issueList(state).find(candidate => candidate.id === argv[1]);
    if (!issue) {
      err(`stub ${STUB_BIN}: no such issue '${argv[1]}'\n`);
      return 1;
    }
    issue.comments = Array.isArray(issue.comments) ? issue.comments : [];
    issue.comments.push({ id: `c-${issue.comments.length + 1}`, text: String(argv[2] || '') });
    writeState(statePath, state);
    out(`${JSON.stringify({ id: issue.id, status: issue.status })}\n`);
    return 0;
  }

  if (verb === 'close' || verb === 'close-with-reason') {
    const issue = issueList(state).find(candidate => candidate.id === argv[1]);
    if (!issue) {
      err(`stub ${STUB_BIN}: no such issue '${argv[1]}'\n`);
      return 1;
    }
    if (verb === 'close-with-reason') {
      const reason = String(argv[2] || '');
      const commit = String(argv[3] || '');
      // kata's server refuses a thin reason or a sha it cannot resolve; the stub refuses the
      // same way, so "the reason really is long enough" is the tracker's answer, not ours.
      if (kata && (reason.length < KATA_REASON_MIN || !KATA_COMMIT_RE.test(commit))) {
        err(`stub ${STUB_BIN}: close-with-reason needs a >=40-character reason and a commit sha\n`);
        return 1;
      }
      issue.closure = { commit, reason };
    }
    issue.status = 'closed';
    writeState(statePath, state);
    out(`${JSON.stringify({ id: issue.id, status: issue.status })}\n`);
    return 0;
  }

  err(`stub ${STUB_BIN}: unexpected ${JSON.stringify(argv)}\n`);
  return 1;
}

/**
 * The read-only half of the stub: the two reads that carry no mutation and so are answered
 * before the mutation log is touched. Kept separate from `runStubCli`'s mutating tail only for
 * readability; the dispatch order is unchanged.
 */
function runStubRead(verb, argv, { kata, state, statePath, out, err }) {
  if (verb === 'comments') {
    const issue = issueList(state).find(candidate => candidate.id === argv[1]);
    if (!issue) {
      err(`stub ${STUB_BIN}: no such issue '${argv[1]}'\n`);
      return 1;
    }
    const comments = Array.isArray(issue.comments) ? issue.comments : [];
    // Two real shapes: `br comments list` prints a bare array of `{id, text}`; `kata show`
    // prints `{comments: [{id, body}], comments_truncated}`. A reader that only knew one of
    // them would work on one tracker and silently see no comments on the other.
    out(
      `${JSON.stringify(
        kata
          ? {
              comments: comments.map(c => ({ body: c.text, id: c.id })),
              comments_truncated: false,
            }
          : comments
      )}\n`
    );
    return 0;
  }

  if (verb === 'export') {
    // `tracker.stage-export`'s textual mirror: one JSON record per line, as `.beads/issues.jsonl`
    // holds them, so `trd-cli beads-stage` has a real export to scope.
    out(exportJsonl(issueList(state)));
    return 0;
  }

  if (verb === 'script') {
    // `package-runner.run-script` as a real package runner answers it: the script's own output,
    // and the script's own exit code. A FAILING suite prints to stderr, which is where the
    // toolchain runner reads a non-zero exit's detail from -- a reader that only looked at
    // stdout would lose the failing file names.
    const suite = (state.control || {}).suite || {};
    const exitCode = Number(suite.exitCode || 0);
    const output =
      typeof suite.output === 'string' ? suite.output : `> ${argv[1]}\n\nTests passed\n`;
    if (exitCode === 0) out(output);
    else err(output);
    return exitCode;
  }

  if (verb === 'test-run') {
    const control = state.control || {};
    if (control.failTestRunner === true) {
      err(`stub ${STUB_BIN}: test-run crashed\n`);
      return 2;
    }
    const result = control.testResult || { failed: 0, passed: 0, total: 0, success: true };
    const body = {
      duration: 1,
      failed: Number(result.failed || 0),
      failures: Array.isArray(result.failures) ? result.failures : [],
      passed: Number(result.passed || 0),
      skipped: Number(result.skipped || 0),
      success: result.success !== false,
      total: Number(result.total || 0),
    };
    if (control.testResultShape) Object.assign(body, control.testResultShape);
    out(`${JSON.stringify(body)}\n`);
    // A failing SUITE is exit 1, not a crash -- exactly what the shipped runner scripts do and
    // why `test-runner.run` declares `successExitCodes: [0, 1]`.
    return body.success ? 0 : 1;
  }

  return null;
}

/** The issues as the tracked `.beads/issues.jsonl` export holds them. */
function exportJsonl(issues) {
  return issues
    .map(issue =>
      `${JSON.stringify({
        id: issue.id,
        labels: Array.isArray(issue.labels) ? issue.labels : [],
        status: issue.status,
        title: issue.title,
        type: issue.type,
      })}\n`
    )
    .join('');
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
function capabilityTable(declare, createParse, exposeDependencies) {
  const on = key => declare[key] !== false;
  const idParse = { format: 'json', root: '$', map: { id: '$.id' } };
  const table = {
    // `filter` is the category's own selector; `all` is the one value that makes a kata-shaped
    // tracker list closed work too, which is how a finished phase can ever look finished.
    'tracker.list': {
      run: [STUB_BIN, 'list'],
      variants: { filter: { all: [STUB_BIN, 'list', '--all'], '*': [STUB_BIN, 'list'] } },
    },
    // Modelled on `adapter-tracker-beads/adapter.yaml` :68-98, plus the one field no shipped
    // tracker maps today: `dependencies`. `exposeDependencies: false` drops it again, which is
    // exactly what a reader of live edges meets on the shipped beads and kata adapters.
    'tracker.show': {
      run: [STUB_BIN, 'show', '${id}'],
      parse: {
        format: 'json',
        root: '$',
        map: {
          id: '$.id',
          title: '$.title',
          description: { path: '$.description', optional: true },
          type: '$.type',
          status: '$.status',
          labels: { path: '$.labels', default: [] },
          ...(exposeDependencies
            ? { dependencies: { path: '$.dependencies', optional: true } }
            : {}),
        },
        statusMap: { open: 'open', in_progress: 'in_progress', closed: 'closed' },
      },
    },
    'tracker.create': {
      run: [STUB_BIN, 'create', '${title}', '${type}', '${description}'],
      ...(createParse ? { parse: idParse } : {}),
    },
    'tracker.comment': { run: [STUB_BIN, 'comment', '${id}', '${text}'], parse: idParse },
    'tracker.close': { run: [STUB_BIN, 'close', '${id}'], parse: idParse },
  };
  // Modelled on `adapter-tracker-beads/adapter.yaml` :338 (`br comments list`) and
  // `adapter-tracker-kata/adapter.yaml` :457 (`kata close --done -m <reason> --commit <sha>`):
  // both are OPTIONAL capabilities, so a tracker that lacks either is a shape the verb meets.
  if (on('comments')) table['tracker.comments'] = { run: [STUB_BIN, 'comments', '${id}'] };
  if (on('closeWithReason')) {
    table['tracker.close-with-reason'] = {
      run: [STUB_BIN, 'close-with-reason', '${id}', '${reason}', '${commit}'],
      parse: idParse,
    };
  }
  if (on('stageExport')) table['tracker.stage-export'] = { run: [STUB_BIN, 'export'] };
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
  if (on('setStatus')) {
    table['tracker.set-status'] = {
      run: [STUB_BIN, 'set-status', '${id}', '${status}'],
      parse: {
        format: 'json',
        root: '$',
        map: { id: '$.id', status: '$.status' },
        statusMap: { open: 'open', in_progress: 'in_progress', closed: 'closed' },
      },
    };
  }
  if (on('sync')) table['tracker.sync'] = { run: [STUB_BIN, 'sync'] };
  return table;
}

/**
 * Install the stateful stub tracker in a fixture project: the binary on the fixture `PATH`, an
 * installed-origin adapter manifest under `<root>/packages/fixture-pkg/skills/`, and
 * `.ensemble/toolchain.yaml` naming it. Call it BEFORE `initRepo` so the committed tree is clean.
 *
 * @param {string} root the project root
 * @param {{adapter?: string, createParse?: boolean, declare?: object, exposeDependencies?: boolean,
 *   issues?: object[], workGraph?: 'builtin'|'unavailable'}} [options]
 *   `adapter: 'kata'` makes the manifest claim the `kata` id, which shadows the library's own
 *   kata adapter by discovery order and switches the verb onto its kata path.
 *   `exposeDependencies: false` removes `dependencies` from the `tracker.show` mapping, the
 *   situation on every shipped tracker adapter today; `listDependencies: false` drops them from
 *   the `list` rows as `br list` does, which is what makes a per-bead `tracker.show` read the
 *   only way to see an edge.
 *   `workGraph: 'builtin'` (the default) leaves `work-graph` off the manifest's categories, so
 *   the toolchain's own links fallback answers the work-graph capabilities from `tracker.list`
 *   plus `tracker.show`; `workGraph: 'unavailable'` claims the category and declares none of
 *   its capabilities, so every work-graph call comes back `unavailable`.
 * @returns {object} the handle described in this module's tests
 */
function createTrackerStub(root, options = {}) {
  const {
    adapter = 'fixture-tracker',
    createParse = true,
    declare = {},
    exposeDependencies = true,
    issues = [],
    listDependencies = true,
    packageRunner = true,
    packageRunnerExtraArg = false,
    workGraph = 'builtin',
  } = options;
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
    `process.exit(runStubCli(process.argv.slice(2), ${JSON.stringify({
      kata,
      listDependencies,
      log,
      state: statePath,
    })}));`,
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
      categories: workGraph === 'unavailable' ? ['tracker', 'work-graph'] : ['tracker'],
      contract:
        workGraph === 'unavailable'
          ? { tracker: '1.0', 'work-graph': '2.0' }
          : { tracker: '1.0' },
      binaries: [STUB_BIN],
      allowlist: [{ bin: STUB_BIN, sub: [...SUBCOMMANDS] }],
      env: [],
      health: [{ id: 'tracker-version', run: [STUB_BIN, '--version'], timeoutMs: 5000 }],
      detect: [],
      capabilities: capabilityTable(declare, createParse, exposeDependencies),
    })
  );
  fs.writeFileSync(path.join(adapterDir, 'SKILL.md'), `# ${adapter}\n`);

  // The test runner is a SEPARATE adapter, as it is in a real workspace: its own manifest, its
  // own allowlist, its own category. `declare.testRunner: false` still ships and names the
  // adapter but declares no capability, which is what a project whose runner cannot run a
  // suite looks like to the gate. (Omitting the adapter entirely would not model that: the
  // category would fall back to the SHIPPED `default` runner and the gate would reach a real
  // one.)
  const testRunnerAdapter = 'fixture-test-runner';
  const runnerDir = path.join(root, 'packages', 'fixture-pkg', 'skills', testRunnerAdapter);
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.writeFileSync(
    path.join(runnerDir, 'adapter.yaml'),
    yaml.dump({
      adapter: testRunnerAdapter,
      version: '1.0.0',
      categories: ['test-runner'],
      contract: { 'test-runner': '1.0' },
      binaries: [STUB_BIN],
      allowlist: [{ bin: STUB_BIN, sub: [...TEST_RUNNER_SUBCOMMANDS] }],
      env: [],
      health: [{ id: 'runner-version', run: [STUB_BIN, '--version'], timeoutMs: 5000 }],
      detect: [],
      capabilities:
        declare.testRunner === false
          ? {}
          : {
              'test-runner.run': {
                // The shipped runner scripts exit 1 for a FAILING suite, not a crash, so the
                // adapter must opt in the same way `adapter-test-runner-default` does.
                successExitCodes: [0, 1],
                run: [STUB_BIN, 'test-run', '${file}'],
                variants: {
                  framework: {
                    '*': [STUB_BIN, 'test-run', '${file}', '--framework', '${framework}'],
                  },
                },
                parse: {
                  format: 'json',
                  root: '$',
                  map: {
                    duration: '$.duration',
                    failed: '$.failed',
                    failures: { path: '$.failures', default: [] },
                    passed: '$.passed',
                    skipped: { path: '$.skipped', optional: true },
                    success: '$.success',
                    total: '$.total',
                  },
                },
              },
            },
    })
  );
  fs.writeFileSync(path.join(runnerDir, 'SKILL.md'), `# ${testRunnerAdapter}\n`);

  // The package runner is a third adapter, for the same reason: `verify` runs the WHOLE suite
  // through `package-runner.run-script`, which is a different category from the per-phase
  // `test-runner.run` the gate uses, and a scenario must be able to fail one without the other.
  const packageRunnerAdapter = 'fixture-package-runner';
  const packageRunnerDir = path.join(root, 'packages', 'fixture-pkg', 'skills', packageRunnerAdapter);
  fs.mkdirSync(packageRunnerDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageRunnerDir, 'adapter.yaml'),
    yaml.dump({
      adapter: packageRunnerAdapter,
      version: '1.0.0',
      categories: ['package-runner'],
      contract: { 'package-runner': '1.0' },
      binaries: [STUB_BIN],
      allowlist: [{ bin: STUB_BIN, sub: [...PACKAGE_RUNNER_SUBCOMMANDS] }],
      env: [],
      health: [{ id: 'package-runner-version', run: [STUB_BIN, '--version'], timeoutMs: 5000 }],
      detect: [],
      capabilities:
        declare.packageRunner === false
          ? {}
          : {
              'package-runner.run-script': {
                // Both arguments, as the shipped npm adapter declares them: a caller that
                // forgets `args` gets `INVALID_ARG` from the runner, here as it would there.
                run: packageRunnerExtraArg
                  ? // An adapter asking for a value the category's contract never declares: the
                    // runner refuses the call rather than running it, which is the gate a verb
                    // must hand back untouched.
                    [STUB_BIN, 'script', '${script}', '${args}', '${unsupplied}']
                  : [STUB_BIN, 'script', '${script}', '${args}'],
                parse: { format: 'text', map: { output: '$' } },
              },
            },
    })
  );
  fs.writeFileSync(path.join(packageRunnerDir, 'SKILL.md'), `# ${packageRunnerAdapter}\n`);

  const configFile = path.join(root, '.ensemble', 'toolchain.yaml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  // Naming this adapter for `work-graph` too keeps the shipped `auto` sentinel out of the way:
  // the category then resolves to a manifest that claims it and declares none of its
  // capabilities, which is what an adapter that cannot answer them looks like to the runner.
  fs.writeFileSync(
    configFile,
    [
      `tracker: ${adapter}\n`,
      workGraph === 'unavailable' ? `work-graph: ${adapter}\n` : '',
      `test-runner: ${testRunnerAdapter}\n`,
      packageRunner === false ? '' : `package-runner: ${packageRunnerAdapter}\n`,
    ].join('')
  );

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
    /** Delete a bead behind the engine's back, so a planned edge can lose an endpoint. */
    removeIssue: id => {
      const state = read();
      const at = issueList(state).findIndex(candidate => candidate.id === id);
      if (at === -1) throw new Error(`removeIssue: no issue '${id}'`);
      state.issues.splice(at, 1);
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
    /** Accept every `label` call for these ids and store nothing, as a lossy tracker would. */
    dropLabelFor: ids => {
      const state = read();
      state.control = { ...(state.control || {}), dropLabelFor: ids };
      writeState(statePath, state);
    },
    /** Make every later `label` call fail, as an unusable tracker would. */
    failLabel: () => {
      const state = read();
      state.control = { ...(state.control || {}), failLabel: true };
      writeState(statePath, state);
    },
    /** Hide the links of these beads from the list rows only; `show` still carries them. */
    stripListDependenciesFor: ids => {
      const state = read();
      state.control = { ...(state.control || {}), listWithoutDependenciesFor: ids };
      writeState(statePath, state);
    },
    /** Hide the links of these beads from the show answer only; the list still carries them. */
    stripShowDependenciesFor: ids => {
      const state = read();
      state.control = { ...(state.control || {}), stripShowDependenciesFor: ids };
      writeState(statePath, state);
    },
    /**
     * Put the beads a scaffold would have created straight into the stub, from
     * `trd-cli scaffold-calls`' own plan. A scenario that is about the GATE should not pay for
     * a whole scaffold run first, and seeding from the same plan the scaffold obeys keeps the
     * two in step: the titles, types and labels are the planner's, not the test's.
     *
     * @param {{creates: Array<{args: object, kind: string, titlePrefix: string}>}} plan
     * @returns {Record<string, string>} the created id of every title prefix
     */
    seedFromPlan: plan => {
      const state = read();
      const idByPrefix = {};
      for (const create of (plan && plan.creates) || []) {
        const id = `st-${(state.seq || 0) + 1}`;
        state.seq = (state.seq || 0) + 1;
        idByPrefix[create.titlePrefix] = id;
        state.issues = issueList(state).concat({
          dependencies: [],
          description: create.args.description,
          external_ref: create.args.externalKey,
          id,
          labels: String(create.args.labels || '')
            .split(',')
            .filter(part => part.length > 0),
          priority: create.args.priority,
          status: 'open',
          title: create.args.title,
          type: create.args.type,
        });
      }
      writeState(statePath, state);
      return idByPrefix;
    },
    /** The export text `tracker.stage-export` answers, as `.beads/issues.jsonl` holds it. */
    exportText: () => exportJsonl(issueList(read())),
    /** Every comment stored on one issue, in the order they were added. */
    commentsOn: id => {
      const issue = issueList(read()).find(candidate => candidate.id === id);
      return issue && Array.isArray(issue.comments) ? issue.comments : [];
    },
    /** The `{commit, reason}` a `close-with-reason` stored, or null. */
    closureOf: id => {
      const issue = issueList(read()).find(candidate => candidate.id === id);
      return (issue && issue.closure) || null;
    },
    /** What the next `test-runner.run` reports. */
    setTestResult: result => {
      const state = read();
      state.control = { ...(state.control || {}), testResult: result };
      writeState(statePath, state);
    },
    /** Make `test-runner.run` answer a result the contract does not allow. */
    setTestResultShape: shape => {
      const state = read();
      state.control = { ...(state.control || {}), testResultShape: shape };
      writeState(statePath, state);
    },
    /** What the next `package-runner.run-script` prints, and the exit code it ends on. */
    setSuite: ({ exitCode, output }) => {
      const state = read();
      state.control = { ...(state.control || {}), suite: { exitCode, output } };
      writeState(statePath, state);
    },
    /** Make the test runner crash, as an unusable runner would. */
    failTestRunner: () => {
      const state = read();
      state.control = { ...(state.control || {}), failTestRunner: true };
      writeState(statePath, state);
    },
    /** The whole stub state, so a scenario can restore it and prove a re-run changed nothing. */
    snapshot: () => fs.readFileSync(statePath, 'utf8'),
    restore: text => fs.writeFileSync(statePath, text),
    /** Make the list carry a row that is not an issue at all, as a malformed tracker would. */
    nullRowInList: () => {
      const state = read();
      state.control = { ...(state.control || {}), nullRowInList: true };
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
  const {
    interPhaseDepends = false,
    prd = false,
    satisfies = {},
    synth = true,
    targetFiles = false,
  } = options;
  // A `Target File` line only when a scenario needs one: the default output stays byte-identical
  // to what PR 2 and PR 3's suites already pin.
  const target = file => (targetFiles ? [`  - Target File: ${file}`] : []);
  // Same rule for `[satisfies REQ-NNN]`: only the scenarios that cross-check a PRD carry it, so
  // the default TRD is still the one the earlier suites parse.
  const sat = id => (satisfies[id] ? ` [satisfies ${satisfies[id]}]` : '');
  const lines = [
    '---',
    'status: In Progress',
    ...(prd ? ['prd: docs/PRD/PRD-fixture.md'] : []),
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
    `- [ ] **TRD-001**: Create widget storage (2h)${sat('TRD-001')}`,
    '  - Implementation AC:',
    '    - [ ] Storage accepts widgets',
  ];
  if (synth) lines.push('  - [ ] Verify the storage test suite covers rejection');
  lines.push(
    '',
    '- [ ] **TRD-001-TEST**: Widget storage tests (1h) [depends: TRD-001]',
    ...target('tests/widget-store.test.js'),
    '  - Test AC:',
    '    - [ ] Scenario: storing a widget keeps it',
    '',
    `- [ ] **TRD-002**: Read widget storage (2h) [depends: TRD-001]${sat('TRD-002')}`,
    '  - Implementation AC:',
    '    - [ ] Storage returns widgets',
    '',
    '- [ ] **TRD-002-TEST**: Widget read tests (1h) [depends: TRD-002]',
    ...target('tests/widget-read.test.js'),
    '  - Test AC:',
    '    - [ ] Scenario: reading a stored widget returns it',
    '',
    '### Phase 2: Deletion',
    '',
    '**Shippable State:** widgets can be deleted',
    '',
    `- [ ] **TRD-003**: Delete widget storage (2h) [depends: ${
      interPhaseDepends ? 'TRD-002-TEST' : 'TRD-002'
    }]${sat('TRD-003')}`,
    '  - Implementation AC:',
    '    - [ ] Storage deletes widgets',
    '',
    '- [ ] **TRD-003-TEST**: Widget deletion tests (1h) [depends: TRD-003]',
    ...target('tests/widget-delete.test.js'),
    '  - Test AC:',
    '    - [ ] Scenario: deleting a widget removes it',
    '',
    `- [ ] **TRD-004**: Report widget storage (2h) [depends: TRD-003]${sat('TRD-004')}`,
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

/**
 * The PRD `fixtureTrd({prd: true})` points at: three requirements the fixture TRD's tasks
 * satisfy, one per MoSCoW priority that matters, so a scenario can show a `Could` requirement
 * stays informational while a `Must` one does not.
 *
 * @param {{noPriorities?: boolean, unsatisfied?: boolean}} [options]
 *   `unsatisfied` adds a fourth `Must` requirement no task satisfies, which is the one case
 *   Step 3 must report; `noPriorities` strips every MoSCoW line, which is the coverage sanity
 *   check's own case.
 * @returns {string} the PRD markdown
 */
function fixturePrd(options = {}) {
  const { noPriorities = false, unsatisfied = false } = options;
  const priority = word => (noPriorities ? [] : [`**Priority:** ${word}`, '']);
  const lines = [
    '# PRD: Widget Engine',
    '',
    '## Requirements',
    '',
    '### REQ-001: Store widgets',
    '',
    ...priority('Must'),
    'Widgets can be stored.',
    '',
    '### REQ-002: Delete widgets',
    '',
    ...priority('Should'),
    'Widgets can be deleted.',
    '',
    '### REQ-003: Report widgets',
    '',
    ...priority('Could'),
    'Widget counts can be reported.',
    '',
  ];
  if (unsatisfied) {
    lines.push('### REQ-004: Audit widgets', '', ...priority('Must'), 'Widget edits are audited.', '');
  }
  return lines.join('\n');
}

module.exports = {
  PACKAGE_RUNNER_SUBCOMMANDS,
  STUB_BIN,
  SUBCOMMANDS,
  TEST_RUNNER_SUBCOMMANDS,
  createTrackerStub,
  fixturePrd,
  fixtureTrd,
  runStubCli,
};
