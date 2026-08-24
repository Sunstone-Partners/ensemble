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
const { wholeDirMirrorTarget, looksLikeLinkTarget, deSymlinkedMirrorTarget } = require('../validate-all');

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

/**
 * packages/full/ is assembled entirely out of symlinks. Git for Windows leaves
 * core.symlinks=false unless the installer's symlink option was ticked, and
 * such a checkout writes each one as a small regular file holding the target
 * path. Every presence check in validate-all.js then passes -- lstat reports a
 * healthy regular file -- so the bundle ships path strings where its skills and
 * library code should be, and nothing says so.
 */
describe('looksLikeLinkTarget', () => {
  test('recognizes a POSIX link target left behind by a de-symlinked checkout', () => {
    expect(looksLikeLinkTarget('../../core/skills')).toBe(true);
  });

  test('recognizes a Windows-separator link target', () => {
    expect(looksLikeLinkTarget('..\\..\\core\\skills')).toBe(true);
  });

  test('recognizes one with the trailing newline git may leave', () => {
    expect(looksLikeLinkTarget('../../development/lib/trd-cli.js\n')).toBe(true);
  });

  test('rejects real file content that merely starts with a dot', () => {
    expect(looksLikeLinkTarget('...and then the parser gives up.')).toBe(false);
  });

  test('rejects multi-line content', () => {
    expect(looksLikeLinkTarget('../../core/skills\nsecond line')).toBe(false);
  });

  test('rejects an absolute path, which no mirror here uses', () => {
    expect(looksLikeLinkTarget('/usr/share/skills')).toBe(false);
  });

  test('rejects empty and oversized content', () => {
    expect(looksLikeLinkTarget('   ')).toBe(false);
    expect(looksLikeLinkTarget('../' + 'x'.repeat(300))).toBe(false);
  });
});

describe('deSymlinkedMirrorTarget', () => {
  const fs = require('fs');
  const os = require('os');
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'thing.js'), 'module.exports = 1;\n');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('returns the target for a stand-in whose target resolves', () => {
    const standIn = path.join(dir, 'mirror.js');
    fs.writeFileSync(standIn, './real/thing.js');
    expect(deSymlinkedMirrorTarget(standIn)).toBe('./real/thing.js');
  });

  test('returns null for a stand-in whose target does not resolve', () => {
    // A dangling stand-in is a different defect; the presence checks already
    // cover a genuinely missing mirror, and guessing here would be noise.
    const standIn = path.join(dir, 'mirror.js');
    fs.writeFileSync(standIn, './real/absent.js');
    expect(deSymlinkedMirrorTarget(standIn)).toBeNull();
  });

  test('returns null for a real file that happens to be short', () => {
    const real = path.join(dir, 'small.js');
    fs.writeFileSync(real, 'const a = 1;');
    expect(deSymlinkedMirrorTarget(real)).toBeNull();
  });

  test('returns null for a working symlink, which needs no special handling', () => {
    const link = path.join(dir, 'link.js');
    try {
      fs.symlinkSync(path.join('real', 'thing.js'), link);
    } catch {
      return; // no symlink privilege on this machine; the POSIX path is covered in CI
    }
    expect(deSymlinkedMirrorTarget(link)).toBeNull();
  });
});
