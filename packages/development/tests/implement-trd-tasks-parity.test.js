/**
 * TRD-020-TEST: implement-trd-tasks parity against the pre-rename golden capture.
 *
 * The backend-neutral rename (`ensemble:implement-trd-beads` -> `ensemble:implement-trd-tasks`)
 * must not change what the command does:
 *
 *   - AC-010-1: every phase the beads-named command supported (plan-only execution, unattended
 *     execution, branch selection, status reporting, single-task reset, backlog listing,
 *     workstream generation, delegation to an external runner) is still accepted and reaches the
 *     same handling the golden capture recorded.
 *   - AC-010-2: the scaffolded work items keep the same titles, dependency edges and phase
 *     grouping as the captured plan.
 *   - AC-010-3: the plan-only completion message names the renamed command's execute step.
 *
 * The capture in tests/fixtures/implement-trd/ was recorded before the rename, so each comparison
 * rewrites the retired command name in the captured text (or undoes the rename in the current
 * prose) before comparing. The capture stays read-only evidence; the plan comparison reads the
 * three named fields instead of byte-comparing the 1 MB transcript.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { readDevelopmentSkill, parseWorkflow, parseParameters } = require('./helpers/skill-workflow');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PKG_DIR = path.join(__dirname, '..');
const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'implement-trd');
const TRD_CLI = path.join(PKG_DIR, 'lib', 'trd-cli.js');
const TRD_PATH = path.join(
  REPO_ROOT,
  'docs',
  'TRD',
  'completed',
  'TRD-2026-6995dc96-configurable-tasks-backend-kata.md'
);

const golden = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'command-golden.json'), 'utf8'));
const manifest = yaml.load(fs.readFileSync(path.join(PKG_DIR, 'commands', 'implement-trd-tasks.yaml'), 'utf8'));
const skill = readDevelopmentSkill(manifest.skill);
const workflow = parseWorkflow(skill);

const RETIRED_NAME = 'implement-trd-beads';
const RETIRED_COMMAND = `/ensemble:${RETIRED_NAME}`;
const RENAMED_COMMAND = '/ensemble:implement-trd-tasks';
const RENAMED_NAME = 'implement-trd-tasks';

// The capture predates the rename: rewrite the captured command name to compare it with the
// current prose, and undo the rename in current prose to compare it with the capture.
const applyRename = (text) => text.split(RETIRED_COMMAND).join(RENAMED_COMMAND);
const undoRename = (text) => text.split(RENAMED_COMMAND).join(RETIRED_COMMAND);
// The capture also stores the skill directory name and the command file path, which carry the
// bare (unprefixed) name; those need their own rewrite.
const applyRenameBare = (text) => text.split(RETIRED_NAME).join(RENAMED_NAME);
const toPosixPath = (text) => text.split(path.sep).join('/');

// A TRD task checkbox records progress, not the work-item contract the capture pins.
const withoutCheckbox = (title) => title.replace(/\[([ xX])\]/g, '[ ]');

const goldenRules = golden.argumentRules.rules;
const goldenActionsOf = (phaseName) =>
  golden.workflow.find((p) => p.name === phaseName).steps.flatMap((s) => s.actions);
const currentActionsOf = (phaseName) =>
  workflow.find((p) => p.name === phaseName).steps.flatMap((s) => s.actions);
const currentPreflightActions = currentActionsOf('Preflight');
const currentPreflightText = currentPreflightActions.join('\n');
const currentParameters = parseParameters(skill.body);

describe('TRD-020-TEST: the renamed command preserves every captured phase (AC-010-1)', () => {
  // The capture recorded the five phases as prose. The skill is now a loop over the engine (TRD-021), so
  // "the same handling" means the same behaviour has a home: the flag the capture's rule guarded is a flag
  // of the engine verb that now decides it, and the skill names that verb.
  test('each named phase is still handled: the capture recorded a rule, and an engine verb now owns it', () => {
    const { buildRegistry } = require('../lib/ensemble-cli');
    const registry = buildRegistry();
    const flagsOf = (name) => Object.keys(registry.get('implement', name).inputSchema.properties || {});
    const NAMED_PHASES = [
      { name: 'plan-only execution', rule: (g) => g.includes('`--plan` with `--execute`'), verb: 'args', flags: ['plan', 'execute'], next: ['plan-only', 'execute'] },
      { name: 'unattended execution', parameter: 'foreman', verb: 'args', flags: ['foreman'], next: ['foreman'] },
      { name: 'branch selection', rule: (g) => g.includes('`--branch=<name>`'), verb: 'args', flags: ['branch', 'use-current-branch'], next: ['branch', 'use-current-branch'] },
      { name: 'status reporting', rule: (g) => g === '`--status`', verb: 'args', flags: ['status'] },
      { name: 'single-task reset', rule: (g) => g.includes('`--reset-task TRD-XXX`'), verb: 'args', flags: ['reset-task'] },
      { name: 'backlog listing', rule: (g) => g === '`--list`', verb: 'args', flags: ['list'] },
      { name: 'workstream generation', rule: (g) => g.includes('`--workstream`') || g.includes('`--generate-only`'), verb: 'args', flags: ['workstream', 'generate-only'] },
      { name: 'external-runner delegation', rule: (g) => g.includes('--max-parallel'), verb: 'delegate', flags: ['max-parallel'] },
    ];
    for (const named of NAMED_PHASES) {
      const captured = named.parameter
        ? golden.parameters.filter((p) => p.name === named.parameter)
        : goldenRules.filter((rule) => named.rule(rule.guard));
      expect({ name: named.name, captured: captured.length > 0 }).toEqual({ name: named.name, captured: true });
      for (const flag of named.flags) expect({ name: named.name, flag, owned: flagsOf(named.verb).includes(flag) }).toEqual({ flag, name: named.name, owned: true });
      for (const flag of named.next || []) expect({ name: named.name, flag, owned: flagsOf('next').includes(flag) }).toEqual({ flag, name: named.name, owned: true });
      expect(skill.prompt).toContain(`implement ${named.verb}`);
    }
  });

  test('the command under test is the renamed command the capture recorded', () => {
    expect(applyRenameBare(golden.skill)).toBe(manifest.skill);
    expect(applyRenameBare(golden.sourceYaml)).toBe(
      toPosixPath(path.relative(REPO_ROOT, path.join(PKG_DIR, 'commands', `${RENAMED_NAME}.yaml`)))
    );
  });

  test('the declared parameters are the captured ones', () => {
    const shape = (p) => ({ name: p.name, type: p.type, required: p.required, default: p.default });
    expect(currentParameters.map(shape)).toEqual(golden.parameters.map(shape));
  });

  test('the prompt never invokes the retired command', () => {
    expect(skill.prompt).not.toContain(RETIRED_NAME);
  });
});

describe('TRD-020-TEST: the scaffolded work items match the captured plan (AC-010-2)', () => {
  const captured = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'cli-plan_scaffold_plan.json'), 'utf8'));
  const capturedPlan = captured.json.plan;
  let currentPlan;

  beforeAll(() => {
    const stdout = execFileSync(process.execPath, [TRD_CLI, 'scaffold-plan', TRD_PATH], {
      cwd: PKG_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    currentPlan = JSON.parse(stdout).plan;
  }, 60000);

  const titlesOf = (plan) =>
    plan.tasks.map((task) => `${task.id} | ${task.titlePrefix} | ${withoutCheckbox(task.title)}`);
  const taskEdgesOf = (plan) =>
    plan.tasks
      .map((task) => `${task.id} dependsOn ${JSON.stringify(task.dependsOn || [])}`)
      .sort();
  const depEdgesOf = (plan) =>
    plan.deps.map((dep) => `${dep.type} ${dep.blockerId} -> ${dep.blockedId}`).sort();
  const groupingOf = (plan) => ({
    epic: plan.epic.titlePrefix,
    stories: plan.stories.map((story) => `${story.phaseN} | ${story.titlePrefix} | ${withoutCheckbox(story.title)}`),
    tasks: plan.tasks.map((task) => `${task.id} in phase ${task.phaseN}`),
  });

  test('the capture is non-trivial, so the comparison cannot pass vacuously', () => {
    expect(capturedPlan.tasks.length).toBeGreaterThan(0);
    expect(capturedPlan.stories.length).toBeGreaterThan(0);
    expect(capturedPlan.deps.length).toBeGreaterThan(0);
    expect(currentPlan.tasks.length).toBe(capturedPlan.tasks.length);
    expect(currentPlan.stories.length).toBe(capturedPlan.stories.length);
    expect(currentPlan.deps.length).toBe(capturedPlan.deps.length);
  });

  test('work-item titles are the captured ones', () => {
    expect(titlesOf(currentPlan)).toEqual(titlesOf(capturedPlan));
  });

  test('dependency edges are the captured ones', () => {
    expect(taskEdgesOf(currentPlan)).toEqual(taskEdgesOf(capturedPlan));
    expect(depEdgesOf(currentPlan)).toEqual(depEdgesOf(capturedPlan));
  });

  test('phase grouping is the captured one', () => {
    expect(groupingOf(currentPlan)).toEqual(groupingOf(capturedPlan));
  });
});

describe('TRD-020-TEST: the plan-only completion names the renamed execute step (AC-010-3)', () => {
  const planOnlyActions = (actions) => actions.filter((action) => action.includes('PLAN_ONLY'));

  test('the plan-only completion names the renamed command and not the retired one', () => {
    const messages = skill.prompt.split('\n').filter((line) => line.includes('Plan complete. Bead hierarchy created.'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('/ensemble:implement-trd-tasks --execute');
    expect(messages[0]).not.toContain(RETIRED_NAME);
  });

  test('the plan-only completion is the captured message with the command renamed', () => {
    const [capturedMessage] = goldenActionsOf('Scaffold').filter((action) => action.includes('PLAN_ONLY'));
    const text = applyRename(capturedMessage);
    const sentence = text.match(/'(Plan complete\.[^']*)'/)[1];
    expect(skill.prompt).toContain(sentence);
  });
});
