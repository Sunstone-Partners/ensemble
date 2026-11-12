'use strict';

/**
 * TRD-020: code-reviewer agent -- read-only, structured findings, reads rules.
 *
 * Validates PRD ACs: AC-004-3, AC-004-2 (REQ-004, REQ-001). These are the
 * Implementation AC tests; the PRD-scenario tests live in TRD-020-TEST.
 *
 * What is pinned here:
 *   1. the agent's tool list carries NO Write and NO Edit -- a reviewer that
 *      can edit the tree is not a reviewer (AC-004-3) -- and its mission says
 *      plainly that it may record or post findings only;
 *   2. it reads the applied REVIEW.md files, CLAUDE.md and the project
 *      constitution, so a maintainer's rules reach the reviewer (REQ-001);
 *   3. every finding it reports uses the LEDGER fields (id, source, location
 *      or link, severity tag, failure mode, evidence, original text or link)
 *      and its summary starts with a finding count or says plainly that
 *      nothing needs fixing (AC-004-2);
 *   4. the coverage thresholds in the agent match the constitution (60% unit,
 *      50% integration);
 *   5. the SHIPPED copies -- the generated markdown, the Pi copy and the Codex
 *      TOML -- carry the same read-only tool list, so `npm run generate` was
 *      actually run and the agent an adopting runtime loads is the one
 *      reviewed here.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const YAML_PATH = path.join(REPO_ROOT, 'packages/quality/agents/code-reviewer.yaml');
const GENERATED = [
  'packages/quality/agents/code-reviewer.md',
  'packages/pi/agents/code-reviewer.md',
  'packages/codex/.codex/agents/code-reviewer.toml',
];

const source = fs.readFileSync(YAML_PATH, 'utf8');
const agent = yaml.load(source);

/** The whole agent as one lower-case string: prose lives in many keys, and the claim must be in it. */
const prose = JSON.stringify(agent).toLowerCase();

describe('TRD-020 AC-004-3: the reviewer is read-only', () => {
  test('the tool list carries neither Write nor Edit', () => {
    expect(Array.isArray(agent.metadata.tools)).toBe(true);
    expect(agent.metadata.tools).not.toContain('Write');
    expect(agent.metadata.tools).not.toContain('Edit');
    expect(agent.metadata.tools).not.toContain('MultiEdit');
    expect(agent.metadata.tools).not.toContain('NotebookEdit');
  });

  test('it keeps the tools a reviewer needs: Read, Grep and Bash', () => {
    for (const tool of ['Read', 'Grep', 'Bash']) {
      expect(agent.metadata.tools).toContain(tool);
    }
  });

  test('the mission states it may record or post findings only', () => {
    const summary = agent.mission.summary.toLowerCase();
    expect(summary).toMatch(/read-only/);
    expect(summary).toMatch(/record or post findings/);
  });

  test('"does not handle" names the change it must never make', () => {
    expect(agent.mission.boundaries.doesNotHandle.toLowerCase()).toMatch(/editing|writing|changing/);
  });

  test('no success metric still promises code patches: a read-only reviewer describes the fix, it does not apply it', () => {
    // The 4.0.0 agent is trimmed to responsibilities (no qualityStandards block): the claim lives in prose.
    expect(prose).not.toMatch(/with code patches/);
    expect(prose).toMatch(/fix described in the finding \(never applied by this agent\)/);
  });
});

describe('TRD-020 REQ-001: it reads the rules a maintainer edits', () => {
  test('the applied REVIEW.md files, CLAUDE.md and the constitution are named as inputs', () => {
    expect(prose).toMatch(/review\.md/);
    expect(prose).toMatch(/claude\.md/);
    expect(prose).toMatch(/constitution/);
  });

  test('the rules it applies come from the target branch, never the PR head', () => {
    expect(prose).toMatch(/target branch|base commit|basesha/);
  });
});

describe('TRD-020 AC-004-2: findings are structured and sourced', () => {
  const contract = agent.outputContract;

  test('the agent declares a finding contract with every ledger field', () => {
    expect(contract).toBeDefined();
    expect(Array.isArray(contract.findingFields)).toBe(true);
    for (const field of ['id', 'source', 'locationOrLink', 'severity', 'failureMode', 'evidence', 'originalTextOrLink']) {
      expect(contract.findingFields).toContain(field);
    }
  });

  test('the severity tag is the closed set the ledger enforces', () => {
    expect(contract.severities).toEqual(['important', 'nit', 'pre-existing']);
  });

  test('every finding carries its source, so reviewers who disagree are both recorded', () => {
    expect(JSON.stringify(contract).toLowerCase()).toMatch(/source/);
    expect(contract.summaryRule.toLowerCase()).toMatch(/finding count|number of findings/);
  });

  test('the summary starts with a finding count or says plainly that nothing needs fixing', () => {
    const rule = contract.summaryRule.toLowerCase();
    expect(rule).toMatch(/nothing needs fixing/);
  });
});

describe('TRD-020: coverage thresholds match the constitution', () => {
  test('60% unit and 50% integration', () => {
    // The trimmed agent states the canonical thresholds in its Coverage Thresholds responsibility.
    expect(prose).toMatch(/unit >= 60%, integration >= 50%/);
  });

  test('no prose still claims the old 80/70 thresholds', () => {
    expect(prose).not.toMatch(/≥80%\), integration \(≥70%/);
    expect(prose).not.toMatch(/80% coverage target/);
  });
});

describe('TRD-020: the shipped copies are regenerated from the YAML', () => {
  // The Claude and Pi copies declare a tool list in their frontmatter. The
  // Codex TOML declares none -- it carries the mission text instead -- so its
  // read-only guarantee is checked through the instructions below.
  const WITH_TOOL_LIST = GENERATED.filter((relative) => relative.endsWith('.md'));

  test.each(WITH_TOOL_LIST)('%s carries the read-only tool list', (relative) => {
    const file = path.join(REPO_ROOT, relative);
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    const toolLine = text.split('\n').find((line) => /^tools\s*[:=]/.test(line.trim()));
    expect(toolLine).toBeDefined();
    expect(toolLine).not.toMatch(/\bWrite\b/);
    expect(toolLine).not.toMatch(/\bEdit\b/);
    expect(toolLine).toMatch(/Read/);
  });

  test.each(GENERATED)('%s states the reviewer records findings only', (relative) => {
    const file = path.join(REPO_ROOT, relative);
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8').toLowerCase();
    expect(text).toMatch(/read-only/);
    expect(text).toMatch(/record or post findings only/);
  });

  test.each(GENERATED)('%s carries the finding contract', (relative) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8').toLowerCase();
    expect(text).toMatch(/originaltextorlink/);
    expect(text).toMatch(/nothing needs fixing/);
  });
});
