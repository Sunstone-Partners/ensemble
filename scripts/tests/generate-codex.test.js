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
  buildCodexAgentsMd,
  detectAgentSkills,
  generateCodexSubcommandsSection,
  generateCommandSkills,
  normalizeSkillBody,
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

describe('generateCommandSkills — metadata.visibility (live smoke run, throwaway fixture)', () => {
  const yaml = require('js-yaml');
  const ROOT = path.resolve(__dirname, '..', '..');
  const FIXTURE_PACKAGE_DIR = path.join(ROOT, 'packages', '__codex_visibility_fixture__');
  const FIXTURE_COMMANDS_DIR = path.join(FIXTURE_PACKAGE_DIR, 'commands');
  const SKILLS_DIR = path.join(ROOT, 'packages', 'codex', '.codex', 'skills', 'commands');
  const names = ['vis-hub-fixture', 'vis-hidden-fixture', 'vis-shown-fixture'];

  const skillDir = (n) => path.join(SKILLS_DIR, `ensemble-${n}`);
  const readSkill = (n) => fs.readFileSync(path.join(skillDir(n), 'SKILL.md'), 'utf-8');
  const frontmatterOf = (n) => yaml.load(readSkill(n).split('---\n')[1]);

  function cleanupFixtures() {
    fs.rmSync(FIXTURE_PACKAGE_DIR, { recursive: true, force: true });
    names.forEach((n) => fs.rmSync(skillDir(n), { recursive: true, force: true }));
  }

  beforeAll(() => {
    cleanupFixtures();
    fs.mkdirSync(FIXTURE_COMMANDS_DIR, { recursive: true });
    const write = (n, body) =>
      fs.writeFileSync(path.join(FIXTURE_COMMANDS_DIR, `${n}.yaml`), body.join('\n') + '\n');
    write('vis-hub-fixture', [
      'metadata:',
      '  name: ensemble:vis-hub-fixture',
      '  description: Fixture dispatcher',
      'dispatch:',
      '  subcommands:',
      '    - keyword: hidden',
      '      ref: vis-hidden-fixture',
      '      description: Hidden leaf',
      '    - keyword: shown',
      '      ref: vis-shown-fixture',
      '      description: Shown leaf',
    ]);
    write('vis-hidden-fixture', [
      'metadata:',
      '  name: ensemble:vis-hidden-fixture',
      '  description: Fixture hidden leaf',
      '  visibility: hidden',
    ]);
    write('vis-shown-fixture', [
      'metadata:',
      '  name: ensemble:vis-shown-fixture',
      '  description: Fixture visible leaf',
    ]);
    generateCommandSkills({ dryRun: false, verbose: false });
  });

  afterAll(() => {
    cleanupFixtures();
  });

  test('a hidden command still gets a wrapper skill, marked not user-invocable', () => {
    expect(fs.existsSync(path.join(skillDir('vis-hidden-fixture'), 'SKILL.md'))).toBe(true);
    expect(frontmatterOf('vis-hidden-fixture')['user-invocable']).toBe(false);
  });

  test('a visible command (control) stays user-invocable', () => {
    expect(frontmatterOf('vis-shown-fixture')['user-invocable']).toBe(true);
  });

  test('the dispatcher references the hidden command at its real skill path, and stays invocable', () => {
    expect(frontmatterOf('vis-hub-fixture')['user-invocable']).toBe(true);
    const hub = readSkill('vis-hub-fixture');
    expect(hub).toContain(
      '`packages/codex/.codex/skills/commands/ensemble-vis-hidden-fixture/SKILL.md`'
    );
    expect(hub).toContain(
      '`packages/codex/.codex/skills/commands/ensemble-vis-shown-fixture/SKILL.md`'
    );
  });
});

describe('detectAgentSkills — dotnet skill is separate from blazor', () => {
  test.each([
    ['an ASP.NET mention', 'Builds ASP.NET Core APIs'],
    ['a .NET mention', 'Targets .NET 8'],
    ['a dotnet mention', 'Runs the dotnet CLI'],
  ])('%s selects dotnet but not blazor', (_label, content) => {
    const skills = detectAgentSkills('api-helper', content);
    expect(skills).toContain('dotnet');
    expect(skills).not.toContain('blazor');
  });

  test('a Blazor mention selects blazor without implying dotnet', () => {
    const skills = detectAgentSkills('ui-helper', 'Builds Blazor components');
    expect(skills).toContain('blazor');
    expect(skills).not.toContain('dotnet');
  });

  test('backend-named agents get dotnet (not blazor) with the other backend framework skills', () => {
    expect(detectAgentSkills('backend-developer', 'generic agent text')).toEqual(['dotnet', 'nestjs', 'phoenix', 'rails']);
  });
});

describe('normalizeSkillBody / buildCodexAgentsMd — dotnet skill', () => {
  test('rewrites a bare skills/<name>/ path to the Codex skill directory', () => {
    expect(normalizeSkillBody('Load `skills/dotnet/SKILL.md`')).toBe('Load `.codex/skills/dotnet/SKILL.md`');
    expect(normalizeSkillBody('Load skills/nestjs/SKILL.md')).toBe('Load .codex/skills/nestjs/SKILL.md');
  });

  test('does not double-prefix an already Codex-relative path or rewrite a longer path', () => {
    expect(normalizeSkillBody('Load .codex/skills/react/SKILL.md')).toBe('Load .codex/skills/react/SKILL.md');
    expect(normalizeSkillBody('see packages/react/skills/react/SKILL.md')).toBe('see packages/react/skills/react/SKILL.md');
  });

  test('lists dotnet among the framework skills in the generated AGENTS.md', () => {
    expect(buildCodexAgentsMd(1, 1, 1)).toContain('`blazor`, `dotnet`');
  });
});
