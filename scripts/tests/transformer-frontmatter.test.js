'use strict';
/**
 * Type-preservation tests for the two frontmatter keys that look alike and are not:
 * command `allowed-tools` is a comma-joined STRING, agent `tools` is a flow
 * SEQUENCE. Quoting either the wrong way silently converts a list to a string or
 * back, which changes tool permissions without failing to parse.
 */

const yaml = require('js-yaml');
const { generateCommandFrontmatter } = require('../lib/command-transformer');
const { generateAgentFrontmatter } = require('../lib/agent-transformer');

const parse = (frontmatter) => yaml.load(frontmatter.replace(/^---\n|\n---$/g, ''));

describe('command frontmatter', () => {
  test('allowed-tools stays a comma-joined string, not a list', () => {
    const parsed = parse(generateCommandFrontmatter({
      metadata: { name: 'ensemble:x', description: 'd', allowed_tools: ['Read', 'Write'] }
    }));
    expect(typeof parsed['allowed-tools']).toBe('string');
    expect(parsed['allowed-tools']).toBe('Read, Write');
  });

  test('a colon in category round-trips exactly', () => {
    const parsed = parse(generateCommandFrontmatter({
      metadata: { name: 'ensemble:x', description: 'd', category: 'planning: internal' }
    }));
    expect(parsed.category).toBe('planning: internal');
  });

  test('a bracket-group argument-hint round-trips as a string', () => {
    const parsed = parse(generateCommandFrontmatter({
      metadata: { name: 'ensemble:x', description: 'd', argument_hint: '[prd-path] [--team] [--foundational]' }
    }));
    expect(parsed['argument-hint']).toBe('[prd-path] [--team] [--foundational]');
  });

  test('a block-scalar description emits on one line', () => {
    const frontmatter = generateCommandFrontmatter({
      metadata: { name: 'ensemble:x', description: 'Automated release orchestration,\nand deployment coordination.\n' }
    });
    const descriptionLines = frontmatter.split('\n').filter(l => l.startsWith('description:'));
    expect(descriptionLines).toHaveLength(1);
    expect(parse(frontmatter).description).toBe('Automated release orchestration, and deployment coordination.');
  });

  test('every emitted key survives hostile values at once', () => {
    const parsed = parse(generateCommandFrontmatter({
      metadata: {
        name: 'ensemble:feature',
        description: 'Orchestrate the pipeline: create-prd, refine-prd',
        version: '1.0.0',
        category: 'planning',
        lastUpdated: '2026-03-15',
        allowed_tools: ['Read', 'Bash'],
        argument_hint: '<description> [--skip-refine]',
        model: 'opus'
      }
    }));
    expect(parsed.name).toBe('ensemble:feature');
    expect(parsed.description).toBe('Orchestrate the pipeline: create-prd, refine-prd');
    expect(parsed.model).toBe('opus');
    // Bare 2026-03-15 would parse as a Date; quoted it stays a string.
    expect(typeof parsed['last-updated']).toBe('string');
  });
});

describe('agent frontmatter', () => {
  test('tools stays an array, not a string', () => {
    const parsed = parse(generateAgentFrontmatter({
      metadata: { name: 'a', description: 'd', tools: ['Read', 'Write', 'Bash'] }
    }));
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect(parsed.tools).toEqual(['Read', 'Write', 'Bash']);
  });

  test('a tool name containing a colon still yields discrete elements', () => {
    const parsed = parse(generateAgentFrontmatter({
      metadata: { name: 'a', description: 'd', tools: ['Read', 'Bash: run'] }
    }));
    expect(parsed.tools).toEqual(['Read', 'Bash: run']);
  });

  test('a colon in the description round-trips', () => {
    const parsed = parse(generateAgentFrontmatter({
      metadata: { name: 'helm-chart-specialist', description: 'Helm charts: templating, values, releases', tools: ['Read'] }
    }));
    expect(parsed.description).toBe('Helm charts: templating, values, releases');
  });
});

// ---------------------------------------------------------------------------
// Structural guard.
//
// The value-level assertions above pass whether or not a field was quoted --
// `model: opus` and `model: "opus"` both parse to "opus". That blind spot let
// the `model` key ship unquoted after the other six were converted. These
// assert on the emitted TEXT, so any future key that skips yamlScalar fails
// here rather than waiting for a value that happens to contain YAML syntax.
// ---------------------------------------------------------------------------

/** Every `key: value` line inside a frontmatter block, excluding the --- fences. */
const frontmatterLines = (block) =>
  block.split('\n').filter(line => line !== '---' && line.includes(':'));

describe('every emitted frontmatter value is quoted', () => {
  const FULL_COMMAND = {
    metadata: {
      name: 'ensemble:feature',
      description: 'Orchestrate the pipeline',
      version: '1.0.0',
      category: 'planning',
      lastUpdated: '2026-03-15',
      allowed_tools: ['Read', 'Bash'],
      argument_hint: '<description> [--flag]',
      model: 'high'
    }
  };

  test('command: no key emits a bare unquoted scalar', () => {
    const unquoted = frontmatterLines(generateCommandFrontmatter(FULL_COMMAND))
      .filter(line => !/^[a-z-]+: ("|\[)/.test(line));
    expect(unquoted).toEqual([]);
  });

  test('command: model is quoted after tier mapping', () => {
    // Regression: model was the one key left raw-interpolated.
    expect(generateCommandFrontmatter(FULL_COMMAND)).toContain('model: "opus"');
  });

  test('command: every metadata key present in the source appears in the output', () => {
    const emitted = frontmatterLines(generateCommandFrontmatter(FULL_COMMAND))
      .map(line => line.split(':')[0]);
    expect(emitted.sort()).toEqual(
      ['allowed-tools', 'argument-hint', 'category', 'description', 'last-updated', 'model', 'name', 'version']
    );
  });

  test('agent: no key emits a bare unquoted scalar', () => {
    const block = generateAgentFrontmatter({
      metadata: { name: 'a', description: 'd', tools: ['Read', 'Write'] }
    });
    const unquoted = frontmatterLines(block).filter(line => !/^[a-z-]+: ("|\[)/.test(line));
    expect(unquoted).toEqual([]);
  });

  test('agent: every element inside the tools sequence is quoted', () => {
    const block = generateAgentFrontmatter({
      metadata: { name: 'a', description: 'd', tools: ['Read', 'Write'] }
    });
    const toolsLine = block.split('\n').find(l => l.startsWith('tools:'));
    expect(toolsLine).toBe('tools: ["Read", "Write"]');
  });
});
