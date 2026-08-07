'use strict';
/**
 * Tests for the frontmatter parse gate, one case per defect class observed in
 * the 19 broken artifacts, plus the emitter integration that fails closed.
 */

const { extractFrontmatter, checkFrontmatter } = require('../lib/frontmatter-check');
const { generateMarkdown } = require('../lib/markdown-generator');

const withFrontmatter = (body) => `---\n${body}\n---\n\nBody text.\n`;

describe('extractFrontmatter', () => {
  test('returns the block body', () => {
    expect(extractFrontmatter(withFrontmatter('name: x'))).toBe('name: x');
  });

  test('returns null when there is no block', () => {
    expect(extractFrontmatter('# Just a heading\n')).toBeNull();
  });

  test('returns null when the block is never closed', () => {
    expect(extractFrontmatter('---\nname: x\n')).toBeNull();
  });

  test('tolerates CRLF line endings', () => {
    expect(extractFrontmatter('---\r\nname: x\r\n---\r\n\r\nBody.\r\n')).toBe('name: x');
  });
});

describe('checkFrontmatter accepts valid input', () => {
  test('passes a parseable block', () => {
    expect(() => checkFrontmatter(withFrontmatter('name: "x"'), 'ok.md')).not.toThrow();
  });

  test('passes content with no frontmatter at all', () => {
    // Absence is not a defect -- only an unparseable block is.
    expect(() => checkFrontmatter('# Heading\n', 'plain.md')).not.toThrow();
  });
});

describe('checkFrontmatter rejects each observed defect class', () => {
  const defects = [
    ['bracket group with trailing content', 'argument-hint: [prd-path] [--team] [--foundational]'],
    ['unquoted mid-string colon', 'description: Orchestrate the pipeline: create-prd, refine-prd'],
    ['column-0 continuation line', 'description: Automated release orchestration,\nand deployment coordination.\n\nversion: 1.0.0']
  ];

  test.each(defects)('%s throws', (_label, body) => {
    expect(() => checkFrontmatter(withFrontmatter(body), 'broken.md')).toThrow();
  });

  test('the message names the file and the parser reason', () => {
    let caught;
    try {
      checkFrontmatter(withFrontmatter('description: a: b'), 'packages/product/commands/feature.md');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain('packages/product/commands/feature.md');
    expect(caught.message).toMatch(/mapping|indentation|implicit key/i);
  });
});

describe('generateMarkdown fails closed', () => {
  const source = 'packages/test/commands/hostile.yaml';

  test('a hostile description still produces parseable output', () => {
    const markdown = generateMarkdown({
      metadata: {
        name: 'ensemble:hostile',
        description: 'Runs the pipeline: step one, step two',
        version: '1.0.0',
        argument_hint: '[a-path] [--flag]'
      },
      content: 'Body.'
    }, 'command', source);

    expect(() => checkFrontmatter(markdown, source)).not.toThrow();
  });

  test('an unknown type still throws rather than emitting', () => {
    expect(() => generateMarkdown({ metadata: { name: 'x' } }, 'nonsense', source)).toThrow();
  });
});
