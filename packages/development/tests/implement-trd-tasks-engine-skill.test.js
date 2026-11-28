'use strict';

/**
 * TRD-021-TEST (TRD-2026-d571763f): skill and mirror integrity.
 *
 * The implement-trd-tasks skill is a short loop over the engine: ask `ensemble implement next`, do
 * what it says, ask again. These tests hold the skill to that, against the engine it names:
 *
 *  - every verb the skill names exists in the real registry, and every state and status the engine
 *    can answer with has a place in the loop (a new engine state fails here, not in a user's run);
 *  - the loop's own instruction (pipe `ACTION.args` to `ACTION.verb` on stdin) is run through the
 *    real entry point against a real repository, and does what the flag form does;
 *  - none of the old mechanical step prose is left, and the scanner that says so is shown to find
 *    the old prose;
 *  - the preserved behaviours each have a home, in the skill or in the engine;
 *  - the generated pi and codex copies are the generator's output for the committed source, and the
 *    prompt-budget ratchet has not risen.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildRegistry } = require('../lib/ensemble-cli');
const { STATUS_EXIT } = require('../lib/engine/envelope');
const { buildPlan } = require('../lib/engine/plan');
const { makeCtx, runMain } = require('./helpers/engine-run');
const { initRepo, makeRepo } = require('./helpers/engine-repo');
const { createTrackerStub, fixtureTrd } = require('./fixtures/engine/tracker-stub');
const budget = require('../../../scripts/lib/prompt-budget');

const PKG = path.join(__dirname, '..');
const REPO = path.resolve(PKG, '..', '..');
const SKILL_DIR = path.join(PKG, 'skills', 'ensemble-implement-trd-tasks');
const REFERENCE_DIR = path.join(PKG, 'skills', 'implement-trd-tasks-reference');
const SKILL_REL = 'packages/development/skills/ensemble-implement-trd-tasks/SKILL.md';
const TRD_PATH = 'docs/TRD/widget-engine.md';

const read = file => fs.readFileSync(file, 'utf8');
const SKILL = read(path.join(SKILL_DIR, 'SKILL.md'));
const PHASES = fs
  .readdirSync(path.join(SKILL_DIR, 'references'))
  .sort()
  .map(name => ({ name, text: read(path.join(SKILL_DIR, 'references', name)) }));
const REFERENCE = read(path.join(REFERENCE_DIR, 'SKILL.md'));
/** The whole prompt of the command: the skill and its phase files. */
const PROMPT = [SKILL, ...PHASES.map(phase => phase.text)].join('\n');

/** The text of a `## <heading>` section, up to the next `## ` heading. */
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  if (start === -1) throw new Error(`no '## ${heading}' section`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

describe('the loop is present', () => {
  test('the skill names the engine, the question it asks, the accept step and the three terminal states', () => {
    expect(SKILL).toContain('ensemble implement next');
    expect(SKILL).toContain('implement accept');
    expect(SKILL).toContain('ENSEMBLE_CLI');
    for (const state of ['HALT', 'EXIT', 'COMPLETE']) expect(SKILL).toContain(state);
  });

  test('an engine that cannot be resolved prints the named error and HALTs, never improvising the steps', () => {
    const engine = section(SKILL, 'Engine');
    expect(engine).toContain("ERROR: could not locate the ensemble engine CLI (ENSEMBLE_CLI)");
    expect(engine).toMatch(/HALT/);
    expect(engine).toMatch(/Never fall back to improvising/);
  });

  test('every verb the skill names is registered', () => {
    const registry = buildRegistry();
    const named = new Set();
    for (const match of PROMPT.matchAll(/`(?:ensemble )?(implement|review|trd) ([a-z][a-z-]*)[^`]*`/g)) {
      named.add(`${match[1]} ${match[2]}`);
    }
    expect(named.size).toBeGreaterThanOrEqual(10);
    for (const verb of named) {
      const [group, name] = verb.split(' ');
      expect({ verb, found: Boolean(registry.get(group, name)) }).toEqual({ found: true, verb });
    }
  });

  test('every state `next` can return, and every error status the engine has, has a branch in the loop', () => {
    const states = buildRegistry().get('implement', 'next').outputSchema.properties.STATE.enum;
    const loop = section(SKILL, 'Loop');
    for (const state of states) expect({ state, handled: loop.includes(`\`${state}\``) }).toEqual({ handled: true, state });
    for (const status of Object.keys(STATUS_EXIT).filter(name => name !== 'OK')) {
      expect({ status, handled: loop.includes(status) }).toEqual({ handled: true, status });
    }
  });
});

// ------------------------------------------------------------------------------ the loop, run

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

function widgetRepo() {
  const fx = makeRepo({
    files: {
      '.beads/issues.jsonl': '',
      'README.md': 'widget engine\n',
      'package.json': '{"name":"widget-engine","version":"1.0.0"}\n',
      [TRD_PATH]: fixtureTrd({ targetFiles: true }),
    },
    init: false,
  });
  const pkg = path.join(fx.root, 'packages', 'development');
  fs.mkdirSync(path.join(pkg, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ensemble-development' }));
  fs.mkdirSync(path.join(pkg, 'agents'), { recursive: true });
  for (const name of DEFAULT_AGENTS) {
    fs.writeFileSync(path.join(pkg, 'agents', `${name}.yaml`), `metadata:\n  name: ${name}\n  description: fixture agent\n`);
  }
  fx.tracker = createTrackerStub(fx.root, {});
  initRepo(fx, {});
  return fx;
}

/** The skill's step 3 and 4 as a caller types them: `ensemble implement next <trd>`, then the action. */
function ask(fx, runId, extra = []) {
  return runMain(
    ['--run-id', runId, '--non-interactive', 'implement', 'next', TRD_PATH, ...extra],
    makeCtx({ cwd: fx.root, env: fx.env })
  );
}

describe('the loop runs against the real engine', () => {
  jest.setTimeout(120000);

  test('non-interactive with no branch flag, the engine takes the proposed branch, and no prose says it HALTs', () => {
    const fx = widgetRepo();
    const env = runMain(['--non-interactive', 'implement', 'env', '--preflight'], makeCtx({ cwd: fx.root, env: fx.env }));
    const runId = env.envelope.data.PREFLIGHT.RUN_ID;
    const answer = ask(fx, runId);
    expect({ error: answer.envelope.error, status: answer.envelope.status }).toEqual({ error: undefined, status: 'OK' });
    expect(answer.envelope.data.CONTEXT.branch.BRANCH_RESOLVED_BY).toBe('non-interactive-proposed');
    expect(answer.envelope.data.ACTION.id).toBe('checkout');

    // The prose says what the engine does, wherever it speaks of branch intent.
    for (const [name, text] of [['SKILL.md', SKILL], ['phase 1', PHASES[0].text], ['reference', REFERENCE]]) {
      for (const line of text.split('\n').filter(entry => /branch intent/i.test(entry))) {
        expect({ name, line, halts: /unresolved branch intent[^.]*\bHALT/i.test(line) && !/is not one/.test(line) }).toEqual({ halts: false, line, name });
      }
    }
    expect(PHASES[0].text).toMatch(/non-interactive run takes the proposed branch/);
  });

  test('accept answers a malformed result file INVALID_INPUT and the engine\'s verdict on the work REFUSED, records nothing for either, and the skill routes them differently', () => {
    const fx = widgetRepo();
    const env = runMain(['--non-interactive', 'implement', 'env', '--preflight'], makeCtx({ cwd: fx.root, env: fx.env }));
    const runId = env.envelope.data.PREFLIGHT.RUN_ID;
    const runDir = path.join(fx.root, '.ensemble', 'state', 'engine', runId);
    const rel = (...parts) => path.join('.ensemble', 'state', 'engine', runId, ...parts);
    const accept = (step, file) =>
      runMain(['--run-id', runId, '--non-interactive', 'implement', 'accept', '--step', step, '--result-file', rel('results', file)], makeCtx({ cwd: fx.root, env: fx.env }));
    const recorded = step => fs.existsSync(path.join(runDir, 'accepted', `${step}.json`));
    const prose = step => ({ head: '0'.repeat(40), howToRevert: 'Revert the merge commit.', risk: 'Low: nothing else calls it.', role: 'pr-prose', step });
    const write = (file, text) => {
      fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'results', file), text);
    };

    // A real dispatch: the engine's own hand-off writes the brief and names the step.
    const { handOff } = require('../lib/engine/handoff');
    const call = { env: fx.env, globals: { runId }, now: Math.floor(Date.now() / 1000), projectRoot: fx.root };
    const dispatched = handOff(call, { agents: [{ brief: { base: 'f'.repeat(40), branch: 'feature/widget' }, label: 'phase-1-abc', name: 'prose' }], role: 'pr-prose' });
    const step = dispatched.data.agents[0].step;

    // 1. The FILE is wrong (registered role, existing file, not JSON): INVALID_INPUT / INVALID_JSON, correctable.
    write('bad.json', 'not json');
    const malformed = accept(step, 'bad.json');
    expect({ code: malformed.envelope.error.code, status: malformed.envelope.status }).toEqual({ code: 'INVALID_JSON', status: 'INVALID_INPUT' });
    expect(recorded(step)).toBe(false);

    // 2. A well-formed result for a step the engine never dispatched: REFUSED / NO_DISPATCH, not a file problem.
    write('pr-prose--ghost.json', JSON.stringify(prose('pr-prose--ghost')));
    const undispatched = accept('pr-prose--ghost', 'pr-prose--ghost.json');
    expect({ code: undispatched.envelope.error.code, status: undispatched.envelope.status }).toEqual({ code: 'NO_DISPATCH', status: 'REFUSED' });
    expect(recorded('pr-prose--ghost')).toBe(false);

    // 3. A well-formed result for a real dispatch, produced against another head: REFUSED / STALE_RESULT.
    write(`${step}.json`, JSON.stringify(prose(step)));
    const stale = accept(step, `${step}.json`);
    expect({ code: stale.envelope.error.code, status: stale.envelope.status }).toEqual({ code: 'STALE_RESULT', status: 'REFUSED' });
    expect(recorded(step)).toBe(false);
    expect(stale.exitCode).not.toBe(malformed.exitCode);

    // The skill routes those two classes differently: only the file is corrected, the verdict HALTs.
    const bullet = SKILL.split('\n').find(line => line.includes('`NEEDS_AGENT`:'));
    expect(bullet).toMatch(/`INVALID_INPUT` means the result file itself is malformed/);
    expect(bullet).toMatch(/`REFUSED`[^.]*HALT/);
    expect(bullet).toMatch(/never changing a claimed status or exit code/);
    expect(bullet).not.toMatch(/(?:fix|correct|repair)[^.;]*result file[^.;]*(?:and|then) (?:accept|retry)/i);
  });

  test('every REFUSED code the accept path can return is one the skill HALTs on, and none of them is a file-shape code', () => {
    const handoff = fs.readFileSync(path.join(PKG, 'lib', 'engine', 'handoff.js'), 'utf8') + fs.readFileSync(path.join(PKG, 'lib', 'engine', 'builder-wave.js'), 'utf8');
    const refusedCodes = [...handoff.matchAll(/refused\(\s*'([A-Z_]+)'/g)].map(m => m[1]);
    const invalidCodes = [...handoff.matchAll(/engineError\(\s*'INVALID_INPUT',\s*'([A-Z_]+)'/g)].map(m => m[1]);
    for (const code of ['STALE_RESULT', 'BUILDER_FAILED', 'EXECUTION_BLOCKED', 'WAVE_RETRY_EXHAUSTED']) expect(refusedCodes).toContain(code);
    for (const code of refusedCodes) expect(invalidCodes).not.toContain(code);
    // The prose names the verdict classes, so a blanket "refused: fix and retry" cannot come back.
    expect(SKILL).not.toMatch(/A refused `accept` means fix/);
  });

  test('`next` answers STEP, and piping ACTION.args to ACTION.verb on stdin (the skill\'s instruction) does what the flags do', () => {
    const fx = widgetRepo();
    // Step 2 of the skill: the run id is `data.PREFLIGHT.RUN_ID` of `implement env --preflight`.
    const env = runMain(['--non-interactive', 'implement', 'env', '--preflight'], makeCtx({ cwd: fx.root, env: fx.env }));
    expect({ error: env.envelope.error, status: env.envelope.status }).toEqual({ error: undefined, status: 'OK' });
    const runId = env.envelope.data.PREFLIGHT.RUN_ID;
    expect(typeof runId).toBe('string');

    const first = ask(fx, runId);
    expect(first.envelope.status).toBe('OK');
    expect(first.envelope.data.STATE).toBe('STEP');
    const action = first.envelope.data.ACTION;
    expect(action.verb).toMatch(/^implement [a-z-]+$/);
    expect(action.args.trd).toBe(TRD_PATH);

    // The prose says: `echo '<args>' | ensemble <verb> --stdin --run-id "$RUN_ID"`.
    const [group, verb] = action.verb.split(' ');
    const viaStdin = runMain(
      ['--run-id', runId, '--non-interactive', group, verb, '--stdin'],
      makeCtx({ cwd: fx.root, env: fx.env, stdin: JSON.stringify(action.args) })
    );
    expect({ error: viaStdin.envelope.error, status: viaStdin.envelope.status }).toEqual({ error: undefined, status: 'OK' });
    expect(viaStdin.exitCode).toBe(0);

  });

  // Found by running the loop end to end, fixed by TRD-020 follow-up #516: the first step, `implement branch
  // --apply`, writes the saved branch choices into the TRD's frontmatter, and the next `implement next` used to
  // refuse 'working directory is dirty' for that very change. Kept as the proof the loop passes its first step.
  test('after the checkout step the engine does not refuse the next call for the dirt it just made, and moves on to the scaffold', () => {
    const fx = widgetRepo();
    const env = runMain(['--non-interactive', 'implement', 'env', '--preflight'], makeCtx({ cwd: fx.root, env: fx.env }));
    const runId = env.envelope.data.PREFLIGHT.RUN_ID;
    const first = ask(fx, runId).envelope.data.ACTION;
    expect(first.id).toBe('checkout');
    const applied = runMain(['--run-id', runId, '--non-interactive', 'implement', 'branch', '--stdin'], makeCtx({ cwd: fx.root, env: fx.env, stdin: JSON.stringify(first.args) }));
    expect({ error: applied.envelope.error, status: applied.envelope.status }).toEqual({ error: undefined, status: 'OK' });
    expect(execFileSync('git', ['status', '--porcelain', '--', TRD_PATH], { cwd: fx.root, encoding: 'utf8' })).not.toBe('');
    const second = ask(fx, runId);
    expect({ error: second.envelope.error, status: second.envelope.status }).toEqual({ error: undefined, status: 'OK' });
    expect(second.envelope.data.ACTION.id).toBe('scaffold');
  });

  test('a step taken out of order is refused by the engine, whatever the skill said', () => {
    const fx = widgetRepo();
    const { envelope, exitCode } = runMain(
      ['--run-id', 'r1', '--non-interactive', 'implement', 'close', TRD_PATH],
      makeCtx({ cwd: fx.root, env: fx.env })
    );
    expect(exitCode).not.toBe(0);
    expect(['REFUSED', 'UNAVAILABLE']).toContain(envelope.status);
  });

  test('the plan runs each gate, then the whole-branch review, then closure, then the completion PR', () => {
    const plan = buildPlan({
      phases: [{ n: 1 }, { n: 2 }],
      prPlan: {
        actions: [{ createPr: false, kind: 'gate', n: 1 }, { createPr: false, kind: 'gate', n: 2 }, { createPr: true, kind: 'completion' }],
        stacked: false,
      },
      slug: 'demo',
      trdPath: 'docs/TRD/demo.md',
    });
    const ids = plan.steps.map(step => step.id);
    const at = id => ids.indexOf(id);
    expect(at('gate-1')).toBeLessThan(at('gate-2'));
    expect(at('gate-2')).toBeLessThan(at('review-completion'));
    expect(at('review-completion')).toBeLessThan(at('close'));
    expect(at('close')).toBeLessThan(at('sync-checkboxes'));
    expect(at('sync-checkboxes')).toBeLessThan(at('pr-completion'));
  });
});

// ------------------------------------------------------------------------------ no mechanical prose

/**
 * The markers of the old mechanical steps: the CLIs the model used to call by hand, the capability
 * calls it made, the variables it kept, the step headings it followed. A marker in the prompt means
 * a step is described in prose that an engine verb now performs.
 */
const MECHANICAL = [
  ['a trd-cli call', /\$TRD_CLI/],
  ['a toolchain-cli call', /\$TOOLCHAIN_CLI/],
  ['a tracker capability call', /\btracker\.(?:create|close|comment|list|dep-add|sync|label|set-status|find-by-key)\b/],
  ['a workflow capability call', /\bworkflow\.(?:commit|propose|push|branch-create|merge-base|status|remote-url)\b/],
  ['a work-graph call', /\bwork-graph\.(?:plan|ready|graph-health)\b/],
  ['bead staging', /beads-stage/],
  ['a plan or label subcommand', /\b(?:scaffold-plan|scaffold-calls|scaffold-dep-args|phase-status|pr-plan|choices-read|choices-write|beads-label|resolve-sdlc|bead-context)\b/],
  ['the PR plan variables', /\b(?:PR_ACTIONS|GATE_ACTION|COMPLETION_ACTION|PHASE_BRANCH_MAP|TRD_TO_BEAD_MAP)\b/],
  ['a numbered step heading', /^#### Step \d+\.\d+/m],
];

/** What the scan reads: the skill without its capability list, the phase files, and the reference without its verbatim sections. */
function scannedProse() {
  const skill = SKILL.replace(section(SKILL, 'Capabilities'), '\n').replace(section(SKILL, 'Arguments'), '\n');
  const reference = REFERENCE.replace(section(REFERENCE, '4. Combined workstream mode (`--workstream` / `--legacy-multi`)'), '\n').replace(
    section(REFERENCE, '8. Kata projects'),
    '\n'
  );
  return [skill, ...PHASES.map(phase => phase.text), reference].join('\n');
}

function mechanicalMarkers(text) {
  return MECHANICAL.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

describe('no mechanical step is described in prose any more', () => {
  test('the prompt carries none of the old markers', () => {
    expect(mechanicalMarkers(scannedProse())).toEqual([]);
  });

  test('the scanner finds every marker in the old prose (it can fail)', () => {
    const old = [
      'Resolve TRD_CLI per the tool-path-resolution skill, run `node "$TRD_CLI" scaffold-plan "<TRD_FILE_PATH>"`.',
      'node "$TOOLCHAIN_CLI" run tracker.close-with-reason --arg id=<STORY_BEAD_ID>',
      'commit via node "$TOOLCHAIN_CLI" run workflow.commit --arg message="chore: checkpoint"',
      'Run work-graph.plan (tracks) and work-graph.graph-health',
      '`node "$TRD_CLI" beads-stage --match "[trd:<TRD_SLUG>"`',
      'GATE_ACTION = PR_ACTIONS[N]. If GATE_ACTION.createPr == false',
      '#### Step 4.1: Per-phase gate',
    ].join('\n');
    expect(mechanicalMarkers(old)).toEqual(MECHANICAL.map(([label]) => label));
  });

  test('the deferred legacy-multi and kata sections are kept as they were, so the scan leaves them out on purpose', () => {
    expect(REFERENCE).toContain('`--legacy-multi` (deprecated; print a DEPRECATED notice listing each TRD): `COMBINED_WORKSTREAM_MODE=true`, `SOURCE_TRD_PATHS` = ordered paths.');
    expect(REFERENCE).toMatch(/\$TRD_CLI/);
  });
});

// ------------------------------------------------------------------------------ preserved behaviours

describe('every preserved behaviour has a home', () => {
  const registry = buildRegistry();
  const flags = (group, name) => Object.keys(registry.get(group, name).inputSchema.properties || {});

  const BEHAVIOURS = [
    ['foreman mode: the flag and the environment variable', () => {
      expect(SKILL).toContain('FOREMAN_TASK_TITLE');
      expect(SKILL).toContain('`foreman`');
      expect(flags('implement', 'next')).toContain('foreman');
    }],
    ['FOREMAN_ARTIFACT_PATH: the report is written to that exact path', () => {
      expect(SKILL).toMatch(/FOREMAN_ARTIFACT_PATH[^\n]*exact path/);
    }],
    ['Foreman tagging of dispatch beads', () => {
      expect(flags('implement', 'bead-health')).toContain('foreman');
    }],
    ['terminal states HALT, EXIT and COMPLETE', () => {
      for (const state of ['HALT', 'EXIT', 'COMPLETE']) expect(SKILL).toContain(state);
    }],
    ['EXIT after --plan, the engine stops at the scaffold', () => {
      expect(flags('implement', 'next')).toContain('plan-only');
      expect(SKILL).toContain('Plan complete. Bead hierarchy created.');
    }],
    ['the kata starting point', () => {
      expect(SKILL).toContain('implement-trd-tasks-reference/reference/kata-starting-point.md');
      expect(fs.existsSync(path.join(REFERENCE_DIR, 'reference', 'kata-starting-point.md'))).toBe(true);
    }],
    ['early exits --list, --status and --reset-task', () => {
      expect(flags('implement', 'args')).toEqual(expect.arrayContaining(['list', 'status', 'reset-task']));
      expect(flags('implement', 'bead-health')).toContain('reset-task');
      for (const verb of ['`ensemble trd list', '`ensemble trd status', '`ensemble implement bead-health']) expect(SKILL).toContain(verb);
    }],
    ['workstream generation and --generate-only', () => {
      expect(flags('implement', 'args')).toEqual(expect.arrayContaining(['workstream', 'generate-only', 'out', 'allow-invalid']));
      expect(registry.get('trd', 'create-workstream-trd')).toBeTruthy();
      expect(SKILL).toContain('`--workstream`');
    }],
    ['--legacy-multi, deferred and verbatim', () => {
      expect(flags('implement', 'args')).toContain('legacy-multi');
      expect(REFERENCE).toContain('`--legacy-multi` (deprecated');
    }],
    ['the unresolved PR backend asks, or HALTs listing ENSEMBLE_PR_BACKEND', () => {
      expect(flags('implement', 'env')).toContain('pr-backend');
      expect(REFERENCE).toContain('PR backend');
    }],
    ['the beads-build-wave agent must be registered, or HALT', () => {
      expect(SKILL).toContain('ERROR: agent beads-build-wave is not registered in this session. Run /ensemble:reinstall-plugins and re-run.');
    }],
    ['archiving the TRD is a human step after every PR has actually merged, never an engine action', () => {
      expect(PHASES[4].text).toMatch(/Archive only after every PR has actually merged, by a person: `mv <trd_file> docs\/TRD\/completed\/`; never while a PR is open/);
      expect(fs.readFileSync(path.join(PKG, 'lib', 'engine', 'verbs', 'implement-close.js'), 'utf8')).not.toMatch(/docs\/TRD\/completed/);
    }],
    ['a pull request is never called merged or landed', () => {
      expect(SKILL).toMatch(/Never call a PR merged or landed/);
    }],
  ];

  test.each(BEHAVIOURS)('%s', (_name, check) => {
    check();
  });
});

// ------------------------------------------------------------------------------ judgement stays

describe('judgement guidance is retained in the skill, not moved into code', () => {
  test.each([
    ['strategy guidance', /^## 2\. Strategy guidance$/m],
    ['review criteria and the PR risk narrative', /^## 3\. Review criteria and PR risk narrative$/m],
    ['how to ask the user', /^## 1\. Asking the user$/m],
    ['the combined workstream and legacy-multi section', /^## 4\. Combined workstream mode/m],
  ])('%s', (_name, heading) => {
    expect(REFERENCE).toMatch(heading);
  });

  test('the strategy section covers every strategy the engine knows', () => {
    const { STRATEGIES } = require('../lib/engine/policy');
    const strategies = section(REFERENCE, '2. Strategy guidance');
    for (const strategy of STRATEGIES) expect(strategies).toContain(`\`${strategy}\``);
  });

  test('the risk narrative asks for the two things the engine inserts unedited', () => {
    const risk = section(REFERENCE, '3. Review criteria and PR risk narrative');
    expect(risk).toContain('**Risk**');
    expect(risk).toContain('**How to revert**');
    expect(risk).toContain('Directed by:');
  });

  test('the judgement code in the engine holds no prose to be moved: the only model-written prose is the pr-prose role', () => {
    const roles = require('../lib/engine/roles').ROLES;
    expect(Object.keys(roles)).toContain('pr-prose');
  });
});

// ------------------------------------------------------------------------------ mirrors and budget

/** Every generated copy of this skill and its reference: what the generators write for it. */
const MIRROR_DIRS = [
  'packages/pi/skills/ensemble-implement-trd-tasks',
  'packages/pi/skills/implement-trd-tasks-reference',
  'packages/codex/.codex/skills/commands/ensemble-implement-trd-tasks',
];

describe('the generated copies follow the source', () => {
  jest.setTimeout(180000);

  test.each(MIRROR_DIRS)('%s carries every phase file and the loop of the source skill', dir => {
    const full = path.join(REPO, dir);
    expect(fs.existsSync(full)).toBe(true);
    if (dir.includes('ensemble-implement-trd-tasks')) {
      for (const phase of PHASES) expect(fs.existsSync(path.join(full, 'references', phase.name))).toBe(true);
      expect(read(path.join(full, 'SKILL.md'))).toContain('ensemble implement next');
    }
  });

  test('regenerating leaves the generated paths exactly as committed', () => {
    const status = () =>
      execFileSync('git', ['status', '--porcelain', '--', ...MIRROR_DIRS], { cwd: REPO, encoding: 'utf8' });
    const before = status();
    for (const script of ['generate:pi', 'generate:codex']) {
      execFileSync('npm', ['run', script], { cwd: REPO, stdio: 'pipe' });
    }
    // A mirror that was stale shows up as a change this run made; the same files modified before the
    // run (a working tree not yet committed) are not a drift of the generator.
    expect(status()).toBe(before);
  });
});

describe('the prompt budget has not risen', () => {
  test('the skill and its references are within their baseline, and the whole ratchet is clean', () => {
    const sizes = budget.collectSizes(path.join(REPO, 'packages'));
    const baseline = budget.loadBaseline();
    const entry = sizes[SKILL_REL];
    expect(entry).toBeDefined();
    const ceiling = baseline[SKILL_REL] === undefined ? budget.CEILINGS.skill : baseline[SKILL_REL];
    expect(entry.words).toBeLessThanOrEqual(ceiling);
    const reference = sizes['packages/development/skills/implement-trd-tasks-reference/SKILL.md'];
    expect(reference.words).toBeLessThanOrEqual(baseline['packages/development/skills/implement-trd-tasks-reference/SKILL.md'] ?? budget.CEILINGS.skill);
    expect(budget.checkBudgets(sizes, baseline).failures).toEqual([]);
  });

  test('the thin skill is much smaller than the prose it replaced', () => {
    // The old skill and its phase files measured 3649 words together.
    expect(budget.collectSizes(path.join(REPO, 'packages'))[SKILL_REL].words).toBeLessThan(3649 / 2);
  });
});
