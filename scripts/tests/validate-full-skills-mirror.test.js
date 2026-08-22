'use strict';
/**
 * Regression test for the Windows readlink-separator bug: fs.readlinkSync
 * returns targets in the platform's own separator form, so the whole-directory
 * skill mirrors in packages/full/skills/ (`core -> ../../core/skills`) were
 * never recognized on Windows. Every package covered by one fell through to the
 * per-skill check and `npm run validate` reported four missing symlinks that
 * exist and are correct, while Linux CI stayed green on the same commit.
 */

const path = require('path');
const { wholeDirMirrorTarget } = require('../validate-all');

describe('wholeDirMirrorTarget', () => {
  test('parses a POSIX whole-directory mirror target', () => {
    expect(wholeDirMirrorTarget('../../core/skills')).toBe('core');
  });

  test('parses a Windows whole-directory mirror target', () => {
    // The bug: this returned null, so `core` was never marked as mirrored.
    expect(wholeDirMirrorTarget('..\\..\\core\\skills')).toBe(
      path.sep === '\\' ? 'core' : null
    );
  });

  test('parses whatever separator form this platform actually produces', () => {
    // The contract that holds on both platforms, stated without branching on
    // the expectation: a target built with path.join always parses.
    const target = ['..', '..', 'git', 'skills'].join(path.sep);
    expect(wholeDirMirrorTarget(target)).toBe('git');
  });

  test('returns null for a per-skill link, which is not a whole-dir mirror', () => {
    const target = ['..', '..', 'development', 'skills', 'developing-with-flutter'].join(path.sep);
    expect(wholeDirMirrorTarget(target)).toBeNull();
  });

  test('returns null for an unrelated target shape', () => {
    expect(wholeDirMirrorTarget('../../development/lib')).toBeNull();
    expect(wholeDirMirrorTarget('./skills')).toBeNull();
  });

  test('leaves a backslash in a POSIX filename alone', () => {
    // On POSIX a backslash is a legal filename character, so splitting on
    // path.sep must not rewrite it. `odd\name` is one directory there and the
    // target is a per-skill link, not a whole-dir mirror.
    if (path.sep !== '/') return;
    expect(wholeDirMirrorTarget('../../odd\\name/skills/thing')).toBeNull();
  });
});
