'use strict';
/**
 * Regression test for the Windows glob-pattern bug: path.join() produces
 * backslash-separated paths, which the `glob` npm package treats as escape
 * characters instead of separators, silently matching zero files.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { toGlobPattern, discoverYamlsInDir } = require('../lib/file-discovery');

// toGlobPattern splits on path.sep, so it converts separators on Windows and is
// a deliberate no-op on POSIX -- where a backslash is a legal filename character
// and glob's own escape character, so rewriting it would be wrong.
const onWindows = path.sep === '\\';

describe('toGlobPattern', () => {
  test('converts path.join output into a forward-slash glob pattern', () => {
    // The actual contract, and it holds on both platforms: whatever path.join
    // produces comes back forward-slash separated.
    const joined = path.join('packages', 'foo', 'commands', '*.yaml');
    expect(toGlobPattern(joined)).toBe('packages/foo/commands/*.yaml');
  });

  test('leaves forward-slash paths unchanged', () => {
    expect(toGlobPattern('packages/foo/commands/*.yaml')).toBe('packages/foo/commands/*.yaml');
  });

  (onWindows ? test : test.skip)('converts literal backslash separators (Windows only)', () => {
    expect(toGlobPattern('packages\\foo\\commands\\*.yaml')).toBe('packages/foo/commands/*.yaml');
  });

  (onWindows ? test.skip : test)('preserves backslashes on POSIX, where they are not separators', () => {
    // On POSIX 'a\\b' is a single filename containing a backslash, not a path.
    expect(toGlobPattern('packages/a\\b/*.yaml')).toBe('packages/a\\b/*.yaml');
  });
});

describe('discoverYamlsInDir', () => {
  test('finds .yaml files via a path.join-constructed directory (regression: previously found 0 on Windows)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-discovery-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.yaml'), 'name: a');
      fs.writeFileSync(path.join(dir, 'b.yaml'), 'name: b');

      const found = await discoverYamlsInDir(dir);

      expect(found.map((f) => path.basename(f)).sort()).toEqual(['a.yaml', 'b.yaml']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
