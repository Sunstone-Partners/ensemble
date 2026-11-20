'use strict';

/**
 * The bundle installs by copying the tree, without an npm install, so a skill directory can have
 * no node_modules of its own. detect-stack therefore matches files with ./glob.js instead of the
 * npm `glob` package. These are the unit tests for that replacement; the proof that it answers
 * the same questions the package answered lives in packages/core/tests, where the npm package is
 * available: packages/core/tests/detect-stack-glob-equivalence.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { glob, expandBraces, segmentMatcher, matchesSegments } = require('../glob');

describe('expandBraces', () => {
  test('a group with alternatives expands to one pattern each', () => {
    expect(expandBraces('**/*.{ts,tsx}')).toEqual(['**/*.ts', '**/*.tsx']);
  });

  test('a group without an alternative stays literal', () => {
    expect(expandBraces('**/{single}.ts')).toEqual(['**/{single}.ts']);
  });

  test('a nested group expands from the inside out', () => {
    expect(expandBraces('**/*.{a,{b,c}}.ts')).toEqual(['**/*.a.ts', '**/*.b.ts', '**/*.c.ts']);
  });
});

describe('segmentMatcher', () => {
  test('a wildcard does not match a leading dot', () => {
    expect(segmentMatcher('*').test('.env')).toBe(false);
    expect(segmentMatcher('.*').test('.env')).toBe(true);
  });

  test('a wildcard does not cross a directory separator', () => {
    expect(segmentMatcher('*').test('a/b')).toBe(false);
  });

  test('a question mark matches exactly one character', () => {
    expect(segmentMatcher('?.cs').test('a.cs')).toBe(true);
    expect(segmentMatcher('?.cs').test('ab.cs')).toBe(false);
  });
});

describe('matchesSegments', () => {
  test('a double star matches zero directories', () => {
    expect(matchesSegments([{ kind: 'starstar' }, { kind: 'segment', test: segmentMatcher('*.csproj') }], ['a.csproj']))
      .toBe(true);
  });

  test('a double star matches any number of directories', () => {
    const compiled = [{ kind: 'starstar' }, { kind: 'segment', test: segmentMatcher('*.csproj') }];
    expect(matchesSegments(compiled, ['one', 'two', 'a.csproj'])).toBe(true);
  });

  test('a double star never matches a dot directory', () => {
    const compiled = [{ kind: 'starstar' }, { kind: 'segment', test: segmentMatcher('*.yaml') }];
    expect(matchesSegments(compiled, ['.hidden', 'secret.yaml'])).toBe(false);
  });
});

describe('glob', () => {
  let root;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-glob-'));
    fs.mkdirSync(path.join(root, 'one'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.yaml'), 'name: a\n');
    fs.writeFileSync(path.join(root, 'one', 'b.yaml'), 'name: b\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an absolute result is an absolute path', async () => {
    const [first] = await glob('**/*.yaml', { cwd: root, absolute: true });
    expect(path.isAbsolute(first)).toBe(true);
  });

  test('a directory is only returned when directories are wanted', async () => {
    const withDirs = await glob('*', { cwd: root });
    expect(withDirs).toContain('one');
    const withoutDirs = await glob('*', { cwd: root, nodir: true });
    expect(withoutDirs).not.toContain('one');
  });

  test('the results are sorted, so a scan is reproducible', async () => {
    const results = await glob('**/*.yaml', { cwd: root });
    expect(results).toEqual([...results].sort());
    expect(results).toEqual(['a.yaml', 'one/b.yaml']);
  });
});