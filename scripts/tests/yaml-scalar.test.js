'use strict';
/**
 * Regression tests for the frontmatter-escaping bug: the generator emitted
 * unquoted YAML plain scalars, so any value containing YAML syntax produced an
 * unparseable frontmatter block and the consumer dropped the whole command or
 * agent silently. 19 of 73 artifacts were affected.
 */

const yaml = require('js-yaml');
const { foldScalar, yamlScalar } = require('../lib/yaml-scalar');

/** Emit `key: value` the way a transformer does, then parse it back. */
const roundTrip = (value, key = 'description') =>
  yaml.load(`${key}: ${yamlScalar(value)}`)[key];

describe('foldScalar', () => {
  test('collapses newlines to single spaces', () => {
    expect(foldScalar('one\ntwo')).toBe('one two');
  });

  test('collapses blank lines and runs of whitespace', () => {
    expect(foldScalar('one\n\n  two\t\tthree')).toBe('one two three');
  });

  test('trims leading and trailing whitespace', () => {
    expect(foldScalar('   padded   ')).toBe('padded');
  });

  test('drops the trailing newline a block scalar leaves behind', () => {
    expect(foldScalar('block scalar text\n')).toBe('block scalar text');
  });
});

describe('yamlScalar round-trips adversarial values', () => {
  // Each case is a real or near-real frontmatter value that broke the old emitter.
  const cases = [
    ['mid-string colon', 'Orchestrate the full idea-to-plan pipeline: create-prd, refine-prd'],
    ['bracket group with trailing content', '[prd-path] [--team] [--foundational]'],
    ['single bracket group', '[trd-path-or-slug]'],
    ['angle-bracket value', '<description> [--skip-refine]'],
    ['embedded newlines and a blank line', 'Automated release orchestration,\n\nand deployment coordination.\n'],
    ['embedded double quote', 'He said "hi" then left'],
    ['embedded backslash', 'a \\ backslash and a \\" quote'],
    ['leading YAML indicators', '*anchor #comment | > % & ! @ `'],
    ['bare namespaced name', 'ensemble:feature'],
    ['padded whitespace', '   leading and trailing   '],
    ['non-ASCII', 'emoji ✓ and unicode é'],
    ['hash mid-string', 'issue #42 tracked here']
  ];

  test.each(cases)('%s', (_label, value) => {
    expect(roundTrip(value)).toBe(foldScalar(value));
  });

  test('every case parses without throwing', () => {
    for (const [, value] of cases) {
      expect(() => yaml.load(`description: ${yamlScalar(value)}`)).not.toThrow();
    }
  });
});

describe('yamlScalar output shape', () => {
  test('always quotes, even when quoting is not strictly required', () => {
    expect(yamlScalar('plain')).toBe('"plain"');
  });

  test('never emits a multi-line scalar', () => {
    expect(yamlScalar('one\ntwo\nthree')).not.toContain('\n');
  });

  test('a value parsed back is a string, not a Date', () => {
    // Bare `last-updated: 2026-03-15` parses as a Date; quoted it stays a string.
    expect(typeof roundTrip('2026-03-15', 'last-updated')).toBe('string');
  });
});
