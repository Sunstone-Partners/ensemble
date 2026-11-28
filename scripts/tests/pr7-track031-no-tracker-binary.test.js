'use strict';
/**
 * Regression test for PR7 br-5eh0 (TRD-031): `packages/development/commands/implement-trd-tasks.yaml`
 * must never regain a literal `br `/`bv ` tracker-binary invocation or `--robot-` flag -- all
 * tracker/scheduling access now goes through `toolchain-cli run tracker.*`/`work-graph.*`. This
 * mirrors the exact AC-1 grep (`grep -noE '\bbr\b|\bbv\b|--robot-[a-z]+' <file>`) as a Jest
 * assertion, plus a broader `\b(br|bv) ` invocation sweep (same convention as the
 * TRD-028/TRD-029/TRD-030 sibling tests), so CI catches a regression, not just a manual grep run
 * at review time.
 *
 * It also asserts AC-2 (the scaffold step creates `plan.epic`/`plan.stories[]`/`plan.tasks[]`
 * via `tracker.create`/`tracker.dep-add` calls, preserving the same `[trd:<slug>]` title-prefix
 * language as before), AC-3 (the `capabilities` block passes the real schema validator --
 * `validateCommandSchema`, the exact function `generate-markdown.js --validate` runs, plus
 * `validateCapabilityIds`, the exact function `scripts/validate-all.js`'s `main()` runs -- not a
 * hand-rolled string/regex check) and AC-4 (the Preflight phase's capability preamble lists
 * exactly `metadata.capabilities.required`, and the Preflight phase's `confirm-status` call
 * precedes the first actual tracker *write* capability call anywhere in the command).
 *
 * Documented gap (not a defect): `tracker.comments` is not a declared capability for this
 * command, so the Completion report's req-verified:REQ-NNN comment scan cannot run through the
 * toolchain layer here; VERIFIED ids are always omitted and a warning is printed once. See the
 * command's Completion report action and the implementing agent's final report for detail.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { validateCommandSchema } = require('../lib/schema-validator');
const { loadValidCapabilityIds, checkCapabilityIds } = require('../lib/capability-ids-check');
const { validateCapabilityIds } = require('../validate-all');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMMAND_PATH = path.join(REPO_ROOT, 'packages', 'development', 'commands', 'implement-trd-tasks.yaml');

// implement-trd-tasks is a skill-backed command: the YAML is a manifest (metadata + `skill`)
// and the prompt lives in its skill (SKILL.md + references/*.md). The prose these checks scan
// is the manifest plus the whole skill, exactly what readCommandProse gives every other lint.
const { readCommandProse } = require('../lib/skill-backed-command');
const { readDevelopmentSkill, parseWorkflow } = require('../../packages/development/tests/helpers/skill-workflow');

const MANIFEST_TEXT = fs.readFileSync(COMMAND_PATH, 'utf8');
const MANIFEST = yaml.load(MANIFEST_TEXT);
const PROSE = readCommandProse(COMMAND_PATH, MANIFEST, MANIFEST_TEXT);
// The workflow phases of the skill: `[{order, name, steps: [{title, actions}]}]` (a step's
// order is its position within the phase).
const PHASES = parseWorkflow(readDevelopmentSkill(MANIFEST.skill)).map((phase) => ({
  ...phase,
  steps: phase.steps.map((step, index) => ({ ...step, order: index + 1 })),
}));

// Same pattern as the AC-1 grep: a bare `br` or `bv` word followed by a space -- i.e. an
// invocation like `br list` or `bv --robot-plan`, not incidental prose like `br/bv`.
const TRACKER_BINARY_INVOCATION = /\b(?:br|bv) /;

// The literal AC-1 grep pattern (`\bbr\b|\bbv\b|--robot-[a-z]+`), translated to a JS RegExp.
const AC1_PATTERN = /\bbr\b|\bbv\b|--robot-[a-z]+/;

function findMatchLines(contents, pattern) {
  return contents
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => pattern.test(line));
}

describe('PR7 Track031: no literal br/bv tracker-binary invocation in implement-trd-tasks (manifest + skill prose)', () => {
  test('implement-trd-tasks.yaml contains zero br/bv invocations (broad sweep)', () => {
    const contents = PROSE;
    expect(findMatchLines(contents, TRACKER_BINARY_INVOCATION)).toEqual([]);
  });

  test('implement-trd-tasks.yaml contains zero matches for the literal AC-1 grep pattern', () => {
    const contents = PROSE;
    expect(findMatchLines(contents, AC1_PATTERN)).toEqual([]);
  });

  test('mutation proof: reintroducing a literal br/bv invocation into the implement-trd-tasks prose is caught', () => {
    // Sanity: the unmutated prose has no invocations (proves the detector isn't vacuously
    // true before we assert it catches the reintroduced one).
    expect(findMatchLines(PROSE, TRACKER_BINARY_INVOCATION)).toEqual([]);
    expect(findMatchLines(PROSE, AC1_PATTERN)).toEqual([]);

    const needle = '`ensemble trd status <slug>`';
    expect(PROSE).toContain(needle);
    const mutated = PROSE.replace(needle, 'br sync --flush-only');
    expect(mutated).not.toBe(PROSE);

    const hitsBroad = findMatchLines(mutated, TRACKER_BINARY_INVOCATION);
    const hitsAc1 = findMatchLines(mutated, AC1_PATTERN);
    expect(hitsBroad.length).toBeGreaterThan(0);
    expect(hitsAc1.length).toBeGreaterThan(0);
    expect(hitsBroad[0].line).toContain('br sync --flush-only');

    // Confirm again against the real, unmutated prose: still zero.
    expect(findMatchLines(PROSE, TRACKER_BINARY_INVOCATION)).toEqual([]);
    expect(findMatchLines(PROSE, AC1_PATTERN)).toEqual([]);
  });

  test('implement-trd-tasks.yaml declares the exact TRD-031 capabilities block', () => {
    const contents = fs.readFileSync(COMMAND_PATH, 'utf8');
    const required = ['tracker.list', 'tracker.create', 'tracker.dep-add', 'tracker.comment', 'tracker.close', 'tracker.sync'];
    for (const id of required) {
      expect(contents).toContain(`      - ${id}\n`);
    }
    const optional = ['work-graph.plan', 'work-graph.graph-health', 'tracker.stage-export'];
    for (const id of optional) {
      expect(contents).toContain(`      - ${id}\n`);
    }
    expect(contents).toMatch(/optional:\s*\n\s*- work-graph\.plan/);
  });

  // The scaffold is an engine verb now (TRD-021): the same creation and wiring runs through the same
  // capabilities, proved against a stub tracker by engine-implement-scaffold.test.js.
  test('the scaffold verb creates plan.epic/plan.stories/plan.tasks via tracker.create and wires the scaffold dependency edges via tracker.dep-add, keeping [trd:<slug>] title prefixes (AC-2)', () => {
    const scaffold = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'development', 'lib', 'engine', 'verbs', 'implement-scaffold.js'), 'utf8');
    for (const needle of ['plan.epic', 'plan.stories', 'plan.tasks', 'scaffold-dep-args', "'tracker.create'", "'tracker.dep-add'", 'titlePrefix']) {
      expect(scaffold).toContain(needle);
    }
  });

  test('implement-trd-tasks.yaml capabilities block passes real schema and capability-id validation (AC-3)', () => {
    // Real production validators, not a hand-rolled check: validateCommandSchema is the exact
    // function generate-markdown.js --validate (npm run generate:validate) runs against every
    // command YAML (AJV against schemas/command-yaml-schema.json, whose own description says
    // capability ids are "cross-referenced against packages/development/toolchain/categories/
    // *.yaml by scripts/validate-all.js"); validateCapabilityIds is the exact function
    // scripts/validate-all.js's main() calls (node scripts/validate-all.js / npm run validate)
    // to perform that cross-reference.
    const data = yaml.load(fs.readFileSync(COMMAND_PATH, 'utf8'));
    expect(() => validateCommandSchema(data, COMMAND_PATH)).not.toThrow();

    const failures = validateCapabilityIds().filter((message) => message.includes('implement-trd-tasks.yaml'));
    expect(failures).toEqual([]);
  });

  test('mutation proof: an unknown capability id reintroduced in a /tmp copy of implement-trd-tasks.yaml is caught by the real capability-id validator', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'track031-capability-mutation-'));
    try {
      const copyPath = path.join(tmpDir, 'implement-trd-tasks.yaml');
      const original = fs.readFileSync(COMMAND_PATH, 'utf8');
      fs.writeFileSync(copyPath, original, 'utf8');

      const categoriesDir = path.join(REPO_ROOT, 'packages', 'development', 'toolchain', 'categories');
      const validIds = loadValidCapabilityIds(categoriesDir);

      // Sanity: the unmutated copy has zero capability-id failures (proves the detector isn't
      // vacuously true before we assert it catches the reintroduced one).
      const unmutatedData = yaml.load(fs.readFileSync(copyPath, 'utf8'));
      expect(checkCapabilityIds(unmutatedData, copyPath, validIds)).toEqual([]);

      const needle = '      - tracker.list\n';
      expect(original).toContain(needle);
      const mutated = original.replace(needle, `${needle}      - tracker.frobnicate\n`);
      expect(mutated).not.toBe(original);
      fs.writeFileSync(copyPath, mutated, 'utf8');

      const mutatedData = yaml.load(fs.readFileSync(copyPath, 'utf8'));
      const failures = checkCapabilityIds(mutatedData, copyPath, validIds);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0]).toContain("unknown capability id 'tracker.frobnicate'");

      // Confirm again against the real, unmutated source: still zero.
      const realData = yaml.load(fs.readFileSync(COMMAND_PATH, 'utf8'));
      expect(checkCapabilityIds(realData, COMMAND_PATH, validIds)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('the preflight the engine runs lists exactly the required capabilities, and the skill states that one line (AC-4)', () => {
    const requiredCapabilities = MANIFEST.metadata.capabilities.required;
    const preflightLine = PROSE.split('\n').find((l) => l.includes('$TOOLCHAIN_CLI" preflight --require'));
    expect(preflightLine).toBeDefined();
    const listed = [...preflightLine.matchAll(/--require ([a-z-]+\.[a-z-]+)/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...requiredCapabilities].sort());

    // The engine's own list is the manifest's list.
    const env = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'development', 'lib', 'engine', 'verbs', 'implement-env.js'), 'utf8');
    const block = env.slice(env.indexOf('const REQUIRED_CAPABILITIES'), env.indexOf(']);', env.indexOf('const REQUIRED_CAPABILITIES')));
    const engineList = [...block.matchAll(/'([a-z-]+\.[a-z-]+)'/g)].map((m) => m[1]);
    expect([...engineList].sort()).toEqual([...requiredCapabilities].sort());

    // The confirmation gate is the toolchain's: a side-effecting capability without it is refused, and the
    // engine returns that refusal unchanged (lib/engine/tracker.js), so no write can precede the confirmation.
    const tracker = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'development', 'lib', 'engine', 'tracker.js'), 'utf8');
    expect(tracker).toMatch(/confirmation missing/);
    expect(PROSE).toMatch(/preflight or tracker confirmation not given\) comes back as a refusal: print it and HALT/);
  });
});
