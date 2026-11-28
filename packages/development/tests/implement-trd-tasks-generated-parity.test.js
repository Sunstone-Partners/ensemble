/**
 * TRD-015-TEST: implement-trd-tasks generated parity
 *
 * Proves that regenerating implement-trd-tasks (a skill-backed command: the YAML is a
 * manifest and the prompt is the skill, SKILL.md + references/) carries the same engine loop
 * into every runtime's copy of the skill (Pi skill, Codex skill), that the Claude Code command
 * and Pi prompt are stubs pointing at it, and that the order the review gates and the closure
 * run in is the engine's own plan (pinned in implement-trd-tasks-engine-skill.test.js: the skill no
 * longer states it, and the engine refuses a step taken out of order) -- plus that both generate:validate and the full validate suite pass.
 *
 * The Claude Code markdown and the Pi prompt of a skill-backed command carry no prompt text
 * (they are stubs), so the content assertions run against the skill prose of the source skill
 * and of the Pi and Codex copies of the skill.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readSkillProse } = require('../../../scripts/lib/skill-backed-command');

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Entry points that are stubs pointing at the skill (no prompt text of their own).
const STUB_FILES = {
  'Claude/OMP markdown': path.join(__dirname, '../commands/ensemble/implement-trd-tasks.md'),
  'Pi prompt': path.join(__dirname, '../../pi/prompts/ensemble-implement-trd-tasks.md'),
};

// Every copy of the skill: SKILL.md plus its references/*.md, read as one prose.
const GENERATED_FILES = {
  'Skill source': path.join(__dirname, '../skills/ensemble-implement-trd-tasks/SKILL.md'),
  'Pi skill': path.join(__dirname, '../../pi/skills/ensemble-implement-trd-tasks/SKILL.md'),
  'Codex skill': path.join(
    __dirname,
    '../../codex/.codex/skills/commands/ensemble-implement-trd-tasks/SKILL.md'
  ),
};

describe('implement-trd-tasks generated parity (TRD-015-TEST)', () => {
  let generated;

  beforeAll(() => {
    generated = {};
    for (const [label, filePath] of Object.entries(GENERATED_FILES)) {
      generated[label] = readSkillProse(filePath);
    }
  });

  test.each(Object.entries(STUB_FILES))(
    '%s: is a stub that points at the ensemble-implement-trd-tasks skill',
    (label, filePath) => {
      const text = fs.readFileSync(filePath, 'utf-8');
      expect(text).toContain('ensemble-implement-trd-tasks');
      expect(text).toMatch(/skill/i);
      expect(text).toContain('$ARGUMENTS');
    }
  );

  test.each(Object.entries(GENERATED_FILES))(
    '%s: carries the engine loop and its three terminal states',
    (label) => {
      const text = generated[label];
      expect(text).toContain('ensemble implement next');
      expect(text).toContain('ensemble implement env --preflight');
      for (const state of ['HALT', 'EXIT', 'COMPLETE']) expect(text).toContain(state);
      expect(text).toContain('NEEDS_AGENT');
      expect(text).toContain('NEEDS_CHOICE');
    }
  );

  test.each(Object.entries(GENERATED_FILES))(
    '%s: carries the anti-early-completion contract (a pending/blocked PR is never described as merged or landed)',
    (label) => {
      const text = generated[label];
      expect(text).toMatch(/Never call a PR merged or landed/);
    }
  );

  test(
    'generated artifacts validate -- generate:validate and the full validate suite both pass (read-only; regeneration idempotency is enforced by the CI generate check on a clean checkout, never by rewriting tracked output from inside a unit test)',
    () => {
      execSync('npm run generate:validate && npm run validate', {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
    },
    120000
  );
});
