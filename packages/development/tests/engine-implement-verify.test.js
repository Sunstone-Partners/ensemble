'use strict';

/**
 * TRD-014-TEST (TRD-2026-d571763f): verification verdicts, `ensemble implement verify <trd>`.
 *
 * Every scenario drives the real entry point `main(argv, ctx)` from `lib/ensemble-cli.js`
 * through the real `buildRegistry()`, against a real git repository whose tracker is the
 * stateful stub of `tests/fixtures/engine/tracker-stub.js` and whose package runner is a second
 * real adapter. Nothing the verb decides -- which tasks are closed, which requirements are
 * covered, what the suite said -- is stubbed out inside the engine.
 *
 * "The verdict is INCOMPLETE" is read off the envelope AND off the report file the run wrote;
 * "the suite ran" is read off the stub's own call log, never off the verb's own report.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildRegistry } = require('../lib/ensemble-cli');
const MESSAGES = require('../lib/engine/messages');
const { expectMatchesOutputSchema, makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo, writeToolchainYaml } = require('./helpers/engine-repo');
const { createTrackerStub, fixturePrd, fixtureTrd } = require('./fixtures/engine/tracker-stub');

/** The file the completion texts come from. */
const CV = path.join(__dirname, '..', 'skills', 'completion-verification', 'SKILL.md');
/** The file the two printed completion lines come from. */
const CMP = path.join(
  __dirname,
  '..',
  'skills',
  'ensemble-implement-trd-tasks',
  'references',
  'phase-5-completion.md'
);

const TRD_PATH = 'docs/TRD/widget-engine.md';
const PRD_PATH = 'docs/PRD/PRD-fixture.md';
const SLUG = 'widget-engine';
const BEADS_EXPORT = '.beads/issues.jsonl';
/** How `scaffold-calls` addresses one task's bead. */
const TASK = id => `[trd:${SLUG}:task:${id}]`;
/** Which REQ each task of the fixture TRD claims. */
const SATISFIES = { 'TRD-001': 'REQ-001', 'TRD-003': 'REQ-002', 'TRD-004': 'REQ-003' };
/** Every task the fixture TRD holds, in plan order. */
const TASKS = [
  'TRD-001',
  'TRD-001-TEST',
  'TRD-002',
  'TRD-002-TEST',
  'TRD-003',
  'TRD-003-TEST',
  'TRD-004',
  'TRD-004-TEST',
];
/**
 * A fixed clock, so the report path and its contents are the same on every run. The date is
 * deliberately not today's: a run that read the wall clock instead of the dispatcher's `now`
 * would write a different path, and that must fail here rather than pass by coincidence.
 */
const NOW = Math.floor(Date.UTC(2026, 2, 14, 12, 0, 0) / 1000);
const DATE = '2026-03-14';
const REPORT = `docs/reports/${SLUG}-completion-${DATE}.md`;

jest.setTimeout(180000);

function verifySpec() {
  return buildRegistry().get('implement', 'verify');
}

/**
 * A project whose TRD is scaffolded into the stub tracker and whose suite passes.
 *
 * @param {{prd?: string|null, preflight?: boolean, stub?: object, trd?: string}} [options]
 * @returns {object} the fixture
 */
function verifyRepo(options = {}) {
  const {
    prd = fixturePrd(),
    preflight = true,
    stub = {},
    trd = fixtureTrd({ prd: true, satisfies: SATISFIES, targetFiles: true }),
  } = options;
  const files = {
    'README.md': 'widget engine\n',
    'package.json': `${JSON.stringify({
      name: SLUG,
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    })}\n`,
    [TRD_PATH]: trd,
    [BEADS_EXPORT]: '',
  };
  if (prd !== null) files[PRD_PATH] = prd;
  const fx = makeRepo({ files, init: false });
  fx.tracker = createTrackerStub(fx.root, stub);
  // The engine's own config has nothing to say here; the toolchain config the stub wrote
  // already names every adapter this verb reaches.
  writeToolchainYaml(fx.root, fs.readFileSync(path.join(fx.root, '.ensemble', 'toolchain.yaml'), 'utf8'));
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

/** The scaffold plan, from the same `trd-cli` verb the scaffold verb runs. */
function scaffoldCalls(fx) {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'lib', 'trd-cli.js'), 'scaffold-calls', TRD_PATH, '--json'],
    { cwd: fx.root, env: fx.env, encoding: 'utf8' }
  );
  return JSON.parse(out);
}

function run(fx, argv = [], globals = ['--run-id', 'r1', '--non-interactive']) {
  return runMain(
    [...globals, 'implement', 'verify', TRD_PATH, ...argv],
    makeCtx({ cwd: fx.root, env: fx.env, now: NOW })
  );
}

/** Close every task-level bead, which is what a finished build leaves behind. */
function closeEveryTask(fx) {
  for (const id of Object.values(fx.ids)) fx.tracker.setStatus(id, 'closed');
}

function git(fx, args) {
  return execFileSync('git', args, { cwd: fx.root, env: fx.env, encoding: 'utf8' }).trim();
}

function callLog(fx) {
  return fx.tracker.calls().map(argv => argv.join(' '));
}

function reportText(fx) {
  return fs.readFileSync(path.join(fx.root, REPORT), 'utf8');
}

/**
 * TRD:467 -- `gapCount` is the length of the gap list and `COMPLETE` happens at zero, asserted
 * on EVERY run rather than in one scenario, so no path can report a count its own list does not
 * carry.
 */
function expectCountMatchesList(envelope) {
  expect(envelope.data.gapCount).toBe(envelope.data.gaps.length);
  expect(envelope.data.verdict).toBe(envelope.data.gapCount === 0 ? 'COMPLETE' : 'INCOMPLETE');
}

describe('a finished TRD verifies as complete', () => {
  test('every task closed, every requirement covered and a passing suite is COMPLETE with no gaps', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.status).toBe('OK');
    expect(envelope.data.verdict).toBe('COMPLETE');
    expect(envelope.data.gaps).toEqual([]);
    expectCountMatchesList(envelope);
    expect(envelope.data.MESSAGE).toBe(MESSAGES.completionPassed(REPORT));
    expect(envelope.data.TRACKING_MODE).toBe('beads');
    expect(envelope.data.TASKS_CHECKED).toBe(4);
    expect(envelope.data.reportPath).toBe(REPORT);
    expectMatchesOutputSchema(verifySpec(), envelope);

    // The verdict line is the report's last line, printed verbatim.
    expect(reportText(fx).trimEnd().split('\n').pop()).toBe(MESSAGES.VERDICT_COMPLETE);
  });

  test('the completion texts are the reference files\' own, not a paraphrase', () => {
    const cv = fs.readFileSync(CV, 'utf8');
    const cmp = fs.readFileSync(CMP, 'utf8');

    expect(cmp).toContain(
      'COMPLETION VERIFICATION FAILED: <gapCount> gap(s) found. Report: <reportPath>'
    );
    expect(cmp).toContain('Completion verification: PASSED (0 gaps). Report: <reportPath>');
    expect(MESSAGES.completionFailed(3, 'docs/reports/x.md')).toBe(
      'COMPLETION VERIFICATION FAILED: 3 gap(s) found. Report: docs/reports/x.md'
    );
    expect(MESSAGES.completionPassed('docs/reports/x.md')).toBe(
      'Completion verification: PASSED (0 gaps). Report: docs/reports/x.md'
    );

    // The skill writes the reason inside a shell-quoted string, so the file carries the
    // escaped spelling of the text the skill prints.
    expect(cv).toContain('node \\"$TRD_CLI\\" parse exited non-zero or returned malformed JSON');
    expect(MESSAGES.PARSE_FAILED_CLI).toBe(
      'node "$TRD_CLI" parse exited non-zero or returned malformed JSON'
    );
    expect(cv).toContain("parser warning: '<matching warning text>'");
    expect(MESSAGES.parserWarning('No tasks found')).toBe("parser warning: 'No tasks found'");
    expect(cv).toContain('tasksById is empty');
    expect(MESSAGES.TASKS_BY_ID_EMPTY).toBe('tasksById is empty');
    expect(cv).toContain(
      'deterministic parser found <PARSED_COUNT> task(s) but a raw grep of the TRD file found <INDEPENDENT_COUNT> task-shaped checkbox line(s)'
    );
    expect(MESSAGES.parseCountMismatch(1, 2)).toContain(
      'deterministic parser found 1 task(s) but a raw grep of the TRD file found 2 task-shaped checkbox line(s)'
    );
    expect(cv).toContain("PRD reference '<trd.prdReference>' could");
    expect(MESSAGES.prdUnresolvable('docs/PRD/x.md')).toBe(
      "PRD reference 'docs/PRD/x.md' could not be resolved to a file"
    );
    expect(cv).toContain('<resolved PRD path>: <N> REQ(s), none with a MoSCoW priority');
    expect(MESSAGES.reqPriorityUnparsed(PRD_PATH, 3)).toBe(
      `${PRD_PATH}: 3 REQ(s), none with a MoSCoW priority`
    );
    expect(cv).toContain('TRD-NNN: still open');
    expect(MESSAGES.taskStillOpen('TRD-002')).toBe('TRD-002: still open');
    expect(cv).toContain('TRD-NNN closed without TRD-NNN-TEST closed');
    expect(MESSAGES.testPairOpen('TRD-001')).toBe('TRD-001 closed without TRD-001-TEST closed');
    expect(cv).toContain('REQ-NNN (Must): no closed satisfying task');
    expect(MESSAGES.reqUnsatisfied('REQ-004', 'Must')).toBe(
      'REQ-004 (Must): no closed satisfying task'
    );
    expect(cv).toContain('**VERDICT: COMPLETE (0 gaps)**');
    expect(MESSAGES.VERDICT_COMPLETE).toBe('**VERDICT: COMPLETE (0 gaps)**');
    expect(cv).toContain('**VERDICT: INCOMPLETE (<N> gaps found)**');
    expect(MESSAGES.verdictIncomplete(2)).toBe('**VERDICT: INCOMPLETE (2 gaps found)**');
  });
});

describe('an unfinished task is a gap that names it', () => {
  test('one open task bead is TASK-OPEN, and its closed test pair is not also reported', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);
    fx.tracker.setStatus(fx.ids[TASK('TRD-002')], 'open');

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.verdict).toBe('INCOMPLETE');
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      { class: 'TASK-OPEN', detail: MESSAGES.taskStillOpen('TRD-002'), task: 'TRD-002' },
    ]);
    expect(envelope.data.MESSAGE).toBe(MESSAGES.completionFailed(1, REPORT));
    expect(reportText(fx)).toContain(`### TASK-OPEN (1)\n- ${MESSAGES.taskStillOpen('TRD-002')}`);
    expect(reportText(fx)).toContain('### TEST-GAP (0)');
    expect(reportText(fx).trimEnd().split('\n').pop()).toBe(MESSAGES.verdictIncomplete(1));
  });

  test('a task closed while its own -TEST task stays open is a TEST-GAP, not a silent pass', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);
    fx.tracker.setStatus(fx.ids[TASK('TRD-001-TEST')], 'open');

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      {
        class: 'TEST-GAP',
        detail: MESSAGES.testPairOpen('TRD-001'),
        task: 'TRD-001',
        testTask: 'TRD-001-TEST',
      },
    ]);
  });
});

describe('a requirement no closed task satisfies is a gap', () => {
  test('a Must requirement with no satisfying task is UNSATISFIED and the Could one is not', () => {
    const fx = verifyRepo({ prd: fixturePrd({ unsatisfied: true }) });
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      {
        class: 'REQ-UNSATISFIED',
        detail: MESSAGES.reqUnsatisfied('REQ-004', 'Must'),
        priority: 'Must',
        req: 'REQ-004',
      },
    ]);
    const report = reportText(fx);
    expect(report).toContain('| REQ-001 | Must | TRD-001 | SATISFIED |');
    expect(report).toContain('| REQ-003 | Could | TRD-004 | informational only |');
    expect(report).toContain('| REQ-004 | Must | (none) | UNSATISFIED |');
  });

  test('a satisfying task that is still open does not satisfy the requirement', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);
    fx.tracker.setStatus(fx.ids[TASK('TRD-001')], 'open');

    const { envelope } = run(fx);

    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toContainEqual({
      class: 'REQ-UNSATISFIED',
      detail: MESSAGES.reqUnsatisfied('REQ-001', 'Must'),
      priority: 'Must',
      req: 'REQ-001',
    });
    expect(reportText(fx)).toContain('| REQ-001 | Must | TRD-001 | UNSATISFIED |');
  });

  test('a PRD reference that resolves to nothing is one gap, and the rest of the step is skipped', () => {
    const fx = verifyRepo({ prd: null });
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      {
        class: 'REQ-UNSATISFIED',
        detail: MESSAGES.prdUnresolvable(PRD_PATH),
      },
    ]);
    // Nothing was read, so nothing is claimed: the coverage table is not rendered from guesses.
    expect(reportText(fx)).not.toContain('| REQ-001 |');
  });

  test('a PRD whose requirements carry no MoSCoW priority is REQ-PRIORITY-UNPARSED', () => {
    const fx = verifyRepo({ prd: fixturePrd({ noPriorities: true }) });
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      {
        class: 'REQ-PRIORITY-UNPARSED',
        detail: MESSAGES.reqPriorityUnparsed(PRD_PATH, 3),
      },
    ]);
    expect(reportText(fx)).toContain(
      `### REQ-PRIORITY-UNPARSED (1)\n- ${MESSAGES.reqPriorityUnparsed(PRD_PATH, 3)}`
    );
  });
});

describe('the full suite is run, and a failing suite is a gap', () => {
  test('a failing suite is TEST-SUITE-FAILURE, names the failing files and keeps the output', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);
    fx.tracker.setSuite({
      exitCode: 1,
      output: 'FAIL tests/widget-store.test.js\n  x stores a widget\nFAIL tests/widget-read.test.js\n',
    });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.verdict).toBe('INCOMPLETE');
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      {
        class: 'TEST-SUITE-FAILURE',
        detail: 'FAIL tests/widget-store.test.js, FAIL tests/widget-read.test.js',
      },
    ]);
    expect(envelope.data.SUITE_OUTPUT).toContain('FAIL tests/widget-store.test.js');
    expect(reportText(fx)).toContain('FAIL — `package-runner.run-script script=test`');
    // The suite really ran: the package runner was called with both declared arguments.
    expect(callLog(fx)).toContain('script test ');
  });

  test('a package runner that cannot run a script is a gap, never a silent pass', () => {
    const fx = verifyRepo({ stub: { declare: { packageRunner: false } } });
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toHaveLength(1);
    expect(envelope.data.gaps[0].class).toBe('TEST-SUITE-FAILURE');
    expect(envelope.data.verdict).toBe('INCOMPLETE');
  });

  test('the shipped npm adapter runs the project\'s own test script with an empty args value', () => {
    const fx = verifyRepo({ stub: { packageRunner: false } });
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.verdict).toBe('COMPLETE');
    expect(envelope.data.gaps).toEqual([]);
    expect(envelope.data.SUITE_OUTPUT).toContain('test');
    expect(reportText(fx)).toContain('PASS — `package-runner.run-script script=test`');
  });
});

describe('a TRD the parser cannot be trusted on blocks verification', () => {
  test('a TRD with no tasks is a PARSE-FAILURE, and steps 2 to 4 never run', () => {
    const fx = verifyRepo({
      prd: null,
      trd: '---\nstatus: In Progress\n---\n\n# TRD: Widget Engine\n\nNo tasks yet.\n',
    });

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(0);
    expect(envelope.data.verdict).toBe('INCOMPLETE');
    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      {
        class: 'PARSE-FAILURE',
        detail: MESSAGES.parserWarning('No tasks found in the TRD'),
      },
    ]);
    expect(envelope.data.TASKS_CHECKED).toBe(0);
    expect(envelope.data.SUITE_OUTPUT).toBeNull();
    // Step 4 is skipped entirely: the suite is never run against an inventory nobody trusts.
    expect(callLog(fx).some(line => line.startsWith('script '))).toBe(false);
  });

  test('a parser that silently misses a real task line is caught by the independent count', () => {
    const trd = fixtureTrd({ prd: false, targetFiles: true }).replace(
      '- [ ] **TRD-004**: Report widget storage (2h) [depends: TRD-003]',
      '- [ ] TRD-004: Report widget storage (2h) [depends: TRD-003]'
    );
    const fx = verifyRepo({ prd: null, trd });

    const { envelope } = run(fx);

    expectCountMatchesList(envelope);
    expect(envelope.data.gaps).toEqual([
      { class: 'PARSE-FAILURE', detail: MESSAGES.parseCountMismatch(7, 8) },
    ]);
  });
});

describe('the report is the durable record of the run', () => {
  test('it is written at the TRD\'s report path for the run\'s own date, and nothing else is written', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);

    const { envelope } = run(fx);

    expect(envelope.data.reportPath).toBe(REPORT);
    expect(fs.existsSync(path.join(fx.root, REPORT))).toBe(true);
    const report = reportText(fx);
    expect(report.startsWith(`# Completion Verification Report: ${SLUG}\n`)).toBe(true);
    expect(report).toContain(`- TRD file: ${TRD_PATH}`);
    expect(report).toContain(`- TRD slug: ${SLUG}`);
    expect(report).toContain(`- Date: ${DATE}`);
    expect(report).toContain('- Tracking mode: beads');
    for (const id of TASKS) expect(report).toContain(`| ${id} | `);
    // The run wrote the report and nothing else: no TRD edit, no tracker mutation.
    expect(git(fx, ['status', '--porcelain'])).toBe('?? docs/reports/');
    expect(fx.tracker.mutations()).toEqual([]);
  });

  test('a second run on the same day overwrites that one report rather than adding another', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);

    run(fx);
    fx.tracker.setStatus(fx.ids[TASK('TRD-002')], 'open');
    const { envelope } = run(fx);

    expect(envelope.data.reportPath).toBe(REPORT);
    expect(fs.readdirSync(path.join(fx.root, 'docs', 'reports'))).toEqual([path.basename(REPORT)]);
    expect(reportText(fx)).toContain(MESSAGES.taskStillOpen('TRD-002'));
    expect(reportText(fx).trimEnd().split('\n').pop()).toBe(MESSAGES.verdictIncomplete(1));
  });

  test('the same inputs twice give the same verdict, the same gap list and the same report bytes', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);
    fx.tracker.setStatus(fx.ids[TASK('TRD-003')], 'open');

    const first = run(fx);
    const firstReport = reportText(fx);
    const second = run(fx);
    const secondReport = reportText(fx);

    expect(second.envelope.data.verdict).toBe(first.envelope.data.verdict);
    expect(second.envelope.data.gaps).toEqual(first.envelope.data.gaps);
    expect(second.envelope.data.gapCount).toBe(first.envelope.data.gapCount);
    expect(second.envelope.data.reportPath).toBe(first.envelope.data.reportPath);
    expect(secondReport).toBe(firstReport);
    expectCountMatchesList(first.envelope);
  });
});

describe('a tracker or toolchain that cannot answer is never a verdict', () => {
  test('a tracker that is not there is UNAVAILABLE, with no verdict and no report', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);
    fs.unlinkSync(path.join(fx.root, 'fixture-bin', 'fixture-tracker'));

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(5);
    expect(envelope.status).toBe('UNAVAILABLE');
    expect(envelope.data).toBeUndefined();
    expect(fs.existsSync(path.join(fx.root, 'docs', 'reports'))).toBe(false);
  });

  test('the toolchain\'s own refusal is returned unchanged instead of being turned into a gap', () => {
    const fx = verifyRepo();
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx, [], ['--run-id', 'BAD ID', '--non-interactive']);

    expect(exitCode).toBe(2);
    expect(envelope.status).toBe('INVALID_INPUT');
    expect(envelope.error.code).toBe('INVALID_RUN_ID');
    expect(fs.existsSync(path.join(fx.root, 'docs', 'reports'))).toBe(false);
  });

  test('a refusal from the suite run itself is handed back, not recorded as a passing suite', () => {
    const fx = verifyRepo({ stub: { packageRunnerExtraArg: true } });
    closeEveryTask(fx);

    const { envelope, exitCode } = run(fx);

    expect(exitCode).toBe(2);
    expect(envelope.status).toBe('INVALID_INPUT');
    expect(envelope.error.code).toBe('INVALID_ARG');
    // No verdict was reached, so no report claims one.
    expect(fs.existsSync(path.join(fx.root, 'docs', 'reports'))).toBe(false);
  });
});
