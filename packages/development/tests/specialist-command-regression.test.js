'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// TRD-011 "Specialist command regression suite" / TRD-011-TEST "Specialist
// commands unchanged"
// (docs/TRD/TRD-2026-87e64cc6-command-surface-consolidation.md#trd-011,
// #trd-011-test). This file adds no new behavior and edits no specialist
// command; it only guards the existing, standalone PRD/TRD/beads commands
// (REQ-004, REQ-018) against silent redirection into either task-oriented
// lifecycle (ensemble:feature/new-feature, ensemble:issue/fix-issue) and
// confirms each remains reachable, generated, and documented.
//
// The list below was confirmed by listing packages/development/commands/*.yaml
// and packages/product/commands/*.yaml directly rather than assumed:
//  - trd.yaml itself, plus every ref in its own dispatch.subcommands[] (11)
//  - prd.yaml itself, plus every ref in its own dispatch.subcommands[] (4 --
//    not just create-prd/refine-prd; create-prd-meeting and refine-prd-meeting
//    are real siblings routed the same way)
//  - the 4 standalone beads-* command YAMLs that actually exist as commands:
//    refine-beads, beads-plan, beads-build, beads-build-wave.
// beads-scaffold-specialist (an agent:
// packages/development/agents/beads-scaffold-specialist.yaml), complete-beads
// (a skill: packages/development/skills/complete-beads/SKILL.md), and
// beads-repair-plan / beads-repair-verify / beads-scope / beads-findings (lib
// CLI tools with their own dedicated tests but no command YAML or generated
// commands/ensemble/*.md) are not command-YAML specialist commands, so they
// are intentionally not enumerated here -- they stay covered by their own
// existing tests, run as part of this package's full suite.
// generate-api-docs.yaml, configure-team.yaml, and implement-bead.yaml
// (development), and analyze-product.yaml, check-feature-drift.yaml,
// check-binding-drift.yaml, generate-feature-tests.yaml,
// generate-reqnroll-bindings.yaml, and reqnroll-tdd.yaml (product) are real
// command YAMLs but are not PRD/TRD/beads document specialists under
// REQ-004/REQ-018 -- none is mentioned anywhere in this TRD or its PRD, and
// none creates/refines/analyzes a PRD, TRD, or beads artifact.
// new-feature.yaml, packages/product/commands/feature.yaml, issue.yaml,
// fix-issue.yaml, and list-issue.yaml are the two task-oriented lifecycles and
// their own dispatchers -- excluded by definition.
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const DEV_COMMANDS_DIR = path.join(REPO_ROOT, 'packages', 'development', 'commands');
const PRODUCT_COMMANDS_DIR = path.join(REPO_ROOT, 'packages', 'product', 'commands');

const SPECIALIST_COMMANDS = [
  ['trd', DEV_COMMANDS_DIR],
  ['create-trd', DEV_COMMANDS_DIR],
  ['create-trd-foreman', DEV_COMMANDS_DIR],
  ['refine-trd', DEV_COMMANDS_DIR],
  ['create-workstream-trd', DEV_COMMANDS_DIR],
  ['implement-trd-beads', DEV_COMMANDS_DIR],
  ['analyze-requirements', DEV_COMMANDS_DIR],
  ['analyze-complexity', DEV_COMMANDS_DIR],
  ['validate-requirements', DEV_COMMANDS_DIR],
  ['verify-requirements', DEV_COMMANDS_DIR],
  ['requirement-status', DEV_COMMANDS_DIR],
  ['trd-dependency-graph', DEV_COMMANDS_DIR],
  ['refine-beads', DEV_COMMANDS_DIR],
  ['beads-plan', DEV_COMMANDS_DIR],
  ['beads-build', DEV_COMMANDS_DIR],
  ['beads-build-wave', DEV_COMMANDS_DIR],
  ['prd', PRODUCT_COMMANDS_DIR],
  ['create-prd', PRODUCT_COMMANDS_DIR],
  ['create-prd-meeting', PRODUCT_COMMANDS_DIR],
  ['refine-prd', PRODUCT_COMMANDS_DIR],
  ['refine-prd-meeting', PRODUCT_COMMANDS_DIR],
];

// dispatch.subcommands[].ref values that would silently route a specialist
// into one of the two task-oriented lifecycles instead of its own behavior.
const TASK_LIFECYCLE_REFS = new Set(['new-feature', 'feature', 'issue', 'fix-issue', 'list-issue']);

function readYaml(dir, slug) {
  return yaml.load(fs.readFileSync(path.join(dir, `${slug}.yaml`), 'utf8'));
}

function readGeneratedMarkdown(dir, slug) {
  return fs.readFileSync(path.join(dir, 'ensemble', `${slug}.md`), 'utf8');
}

function parseFrontmatter(mdText) {
  const match = mdText.match(/^---\n([\s\S]*?)\n---/);
  return match ? yaml.load(match[1]) : null;
}

describe('Specialist command regression suite (TRD-011 / TRD-011-TEST)', () => {
  describe('direct specialist invocation unchanged', () => {
    test.each(SPECIALIST_COMMANDS)('%s source YAML still exists, parses, and outputs to its own slug', (slug, dir) => {
      const yamlPath = path.join(dir, `${slug}.yaml`);
      expect(fs.existsSync(yamlPath)).toBe(true);
      const command = readYaml(dir, slug);
      expect(command.metadata).toBeTruthy();
      expect(typeof command.metadata.name).toBe('string');
      expect(command.metadata.name.length).toBeGreaterThan(0);
      // Guards against a specialist's generated output being silently
      // repointed to overwrite a sibling command's file (including either
      // task-oriented lifecycle's own generated markdown).
      expect(command.metadata.output_path).toBe(`ensemble/${slug}.md`);
    });

    test.each(SPECIALIST_COMMANDS)('%s generated commands/ensemble/*.md still exists, is non-empty, and parses', (slug, dir) => {
      const mdPath = path.join(dir, 'ensemble', `${slug}.md`);
      expect(fs.existsSync(mdPath)).toBe(true);
      const mdText = readGeneratedMarkdown(dir, slug);
      expect(mdText.length).toBeGreaterThan(0);
      const frontmatter = parseFrontmatter(mdText);
      expect(frontmatter).toBeTruthy();
      expect(typeof frontmatter.description).toBe('string');
      expect(frontmatter.description.length).toBeGreaterThan(0);
      const command = readYaml(dir, slug);
      expect(frontmatter.name).toBe(command.metadata.name);
    });
  });

  describe('no silent redirection', () => {
    test.each(SPECIALIST_COMMANDS)('%s has no dispatch entry pointing at the feature or issue task-oriented lifecycles', (slug, dir) => {
      const command = readYaml(dir, slug);
      const subcommands = (command.dispatch && command.dispatch.subcommands) || [];
      const redirecting = subcommands.filter((sub) => TASK_LIFECYCLE_REFS.has(sub.ref));
      expect(redirecting).toEqual([]);
    });
  });

  describe('specialist commands remain documented', () => {
    const EXPECTED_TRD_SUBCOMMAND_REFS = [
      'create-trd',
      'create-trd-foreman',
      'refine-trd',
      'create-workstream-trd',
      'implement-trd-beads',
      'analyze-requirements',
      'analyze-complexity',
      'validate-requirements',
      'verify-requirements',
      'requirement-status',
      'trd-dependency-graph',
    ];
    const EXPECTED_PRD_SUBCOMMAND_REFS = ['create-prd', 'create-prd-meeting', 'refine-prd', 'refine-prd-meeting'];

    test('ensemble:trd dispatch table still routes every TRD specialist, documented as the direct way to use it', () => {
      const command = readYaml(DEV_COMMANDS_DIR, 'trd');
      const refs = command.dispatch.subcommands.map((sub) => sub.ref);
      expect(refs.sort()).toEqual([...EXPECTED_TRD_SUBCOMMAND_REFS].sort());
      const mdText = readGeneratedMarkdown(DEV_COMMANDS_DIR, 'trd');
      for (const ref of EXPECTED_TRD_SUBCOMMAND_REFS) {
        expect(mdText).toContain(`/ensemble:${ref}\` directly`);
      }
    });

    test('ensemble:prd dispatch table still routes every PRD specialist, documented as the direct way to use it', () => {
      const command = readYaml(PRODUCT_COMMANDS_DIR, 'prd');
      const refs = command.dispatch.subcommands.map((sub) => sub.ref);
      expect(refs.sort()).toEqual([...EXPECTED_PRD_SUBCOMMAND_REFS].sort());
      const mdText = readGeneratedMarkdown(PRODUCT_COMMANDS_DIR, 'prd');
      for (const ref of EXPECTED_PRD_SUBCOMMAND_REFS) {
        expect(mdText).toContain(`/ensemble:${ref}\` directly`);
      }
    });

    test('packages/development/README.md command index still lists the specialists it already documents', () => {
      const readme = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'development', 'README.md'), 'utf8');
      for (const name of [
        '/ensemble:implement-trd-beads',
        '/ensemble:refine-beads',
        '/ensemble:create-trd',
        '/ensemble:create-trd-foreman',
        '/ensemble:refine-trd',
      ]) {
        expect(readme).toContain(name);
      }
    });
  });
});
