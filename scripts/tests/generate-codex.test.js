'use strict';
/**
 * Tests for scripts/generate-codex/index.js's parseFrontmatter CRLF fix,
 * and for its dispatcher-command "## Subcommands" rendering (additive
 * dispatcher-command mechanism; see local://dispatcher-command-design.md).
 *
 * The delimiter regex requires a literal '\n' next to '---', so a
 * CRLF-sourced SKILL.md/agent .md (the norm on Windows checkouts with
 * core.autocrlf=true) silently discarded real frontmatter as if it were
 * part of the body.
 */

const fs = require('fs');
const path = require('path');
const {
  parseFrontmatter,
  generateCodexSubcommandsSection,
  generateCommandSkills,
} = require('../generate-codex/index.js');

describe('parseFrontmatter — CRLF line endings', () => {
  const CRLF_CONTENT =
    '---\r\nname: my-agent\r\ndescription: A test agent\r\n---\r\n\r\n# Body\r\n';

  test('detects frontmatter despite \\r\\n around the delimiters', () => {
    const { data } = parseFrontmatter(CRLF_CONTENT);
    expect(data).toEqual({ name: 'my-agent', description: 'A test agent' });
  });

  test('extracts body content with the frontmatter block removed', () => {
    const { content } = parseFrontmatter(CRLF_CONTENT);
    expect(content.trim()).toBe('# Body');
  });

  test('LF content still parses the same as before (no regression)', () => {
    const lfContent = '---\nname: my-agent\ndescription: A test agent\n---\n\n# Body\n';
    expect(parseFrontmatter(lfContent).data).toEqual({ name: 'my-agent', description: 'A test agent' });
  });

  test('no-frontmatter CRLF content reports empty data, not a false match', () => {
    const { data, content } = parseFrontmatter('# Body only\r\n\r\nNo frontmatter here.\r\n');
    expect(data).toEqual({});
    expect(content).toContain('Body only');
  });
});

describe('generateCodexSubcommandsSection', () => {
  test('renders one bullet per subcommand, pointing at the sibling Codex SKILL.md', () => {
    const baseNameToYamlFile = new Map([
      ['fix-issue', '/repo/packages/development/commands/fix-issue.yaml'],
      ['list-issue', '/repo/packages/development/commands/list-issue.yaml'],
    ]);
    const section = generateCodexSubcommandsSection(
      [
        { keyword: 'fix', ref: 'fix-issue', description: 'Fix open bug-report lightweight fixes' },
        { keyword: 'list', ref: 'list-issue', description: '' },
      ],
      baseNameToYamlFile,
      '/repo/packages/development/commands/issue.yaml'
    );

    expect(section).toMatch(/^## Subcommands\n\n/);
    expect(section).toContain(
      '- **`fix`** - Fix open bug-report lightweight fixes. see the `ensemble-fix-issue` skill (`packages/codex/.codex/skills/commands/ensemble-fix-issue/SKILL.md`).'
    );
    expect(section).toContain(
      '- **`list`** - see the `ensemble-list-issue` skill (`packages/codex/.codex/skills/commands/ensemble-list-issue/SKILL.md`).'
    );
  });

  test('throws when a subcommand ref has no matching sibling YAML', () => {
    expect(() =>
      generateCodexSubcommandsSection(
        [{ keyword: 'fix', ref: 'does-not-exist', description: '' }],
        new Map(),
        '/repo/packages/development/commands/issue.yaml'
      )
    ).toThrow(/references unknown command 'does-not-exist'/);
  });

  test('collapses multi-line/whitespace-heavy descriptions to a single sentence prefix', () => {
    const section = generateCodexSubcommandsSection(
      [{ keyword: 'fix', ref: 'fix-issue', description: 'Line one\n  Line   two  ' }],
      new Map([['fix-issue', '/repo/packages/development/commands/fix-issue.yaml']]),
      '/repo/packages/development/commands/issue.yaml'
    );
    expect(section).toContain('- **`fix`** - Line one Line two. see the `ensemble-fix-issue` skill');
  });
});

describe('generateCommandSkills — dispatcher commands (live smoke run, throwaway fixture)', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const FIXTURE_PACKAGE_DIR = path.join(ROOT, 'packages', '__codex_dispatch_fixture__');
  const FIXTURE_COMMANDS_DIR = path.join(FIXTURE_PACKAGE_DIR, 'commands');
  const DISPATCHER_SKILL_DIR = path.join(ROOT, 'packages', 'codex', '.codex', 'skills', 'commands', 'ensemble-dispatcher-fixture');
  const LEAF_SKILL_DIR = path.join(ROOT, 'packages', 'codex', '.codex', 'skills', 'commands', 'ensemble-subcommand-fixture');

  function cleanupFixtures() {
    fs.rmSync(FIXTURE_PACKAGE_DIR, { recursive: true, force: true });
    fs.rmSync(DISPATCHER_SKILL_DIR, { recursive: true, force: true });
    fs.rmSync(LEAF_SKILL_DIR, { recursive: true, force: true });
  }

  beforeAll(() => {
    cleanupFixtures();
    fs.mkdirSync(FIXTURE_COMMANDS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(FIXTURE_COMMANDS_DIR, 'dispatcher-fixture.yaml'),
      [
        'metadata:',
        '  name: ensemble:dispatcher-fixture',
        '  description: Fixture dispatcher command for Codex subcommand rendering test',
        'dispatch:',
        '  subcommands:',
        '    - keyword: sub',
        '      ref: subcommand-fixture',
        '      description: Fixture leaf subcommand',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(FIXTURE_COMMANDS_DIR, 'subcommand-fixture.yaml'),
      ['metadata:', '  name: ensemble:subcommand-fixture', '  description: Fixture leaf command', ''].join('\n')
    );
  });

  afterAll(() => {
    cleanupFixtures();
  });

  test('always reads the raw YAML .dispatch field (invisible in frontmatter-only .md) and appends a ## Subcommands section', () => {
    // Known pre-existing, dispatch-free command: prove this generator run is
    // a byte-identical no-op for it, rather than asserting zero git changes
    // overall (fragile in a shared worktree, since this same feature's own
    // real dispatcher YAMLs legitimately produce their own new, expected
    // untracked output -- that is not a regression to detect here).
    const KNOWN_LEAF_SKILL = path.join(ROOT, 'packages', 'codex', '.codex', 'skills', 'commands', 'ensemble-fix-issue', 'SKILL.md');
    const beforeContent = fs.readFileSync(KNOWN_LEAF_SKILL, 'utf-8');

    // Runs the real end-to-end generator (globs every packages/*/commands/*.yaml,
    // including our throwaway fixture pair) so this proves the live wiring, not
    // just the pure-function unit tests above.
    generateCommandSkills({ dryRun: false, verbose: false });

    const dispatcherSkill = fs.readFileSync(path.join(DISPATCHER_SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(dispatcherSkill).toContain('## Subcommands');
    expect(dispatcherSkill).toContain(
      '- **`sub`** - Fixture leaf subcommand. see the `ensemble-subcommand-fixture` skill (`packages/codex/.codex/skills/commands/ensemble-subcommand-fixture/SKILL.md`).'
    );
    // Subcommands section must land before the mirrored body, per Claude Code's
    // Title -> ... -> Subcommands -> Workflow section order.
    expect(dispatcherSkill.indexOf('## Subcommands')).toBeLessThan(
      dispatcherSkill.indexOf('Fixture dispatcher command for Codex subcommand rendering test')
    );

    const leafSkill = fs.readFileSync(path.join(LEAF_SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(leafSkill).not.toContain('## Subcommands');

    // Idempotency/no-regression proof: a known pre-existing, dispatch-free
    // command's output is unchanged by this generator run.
    const afterContent = fs.readFileSync(KNOWN_LEAF_SKILL, 'utf-8');
    expect(afterContent).toBe(beforeContent);
  });
});
