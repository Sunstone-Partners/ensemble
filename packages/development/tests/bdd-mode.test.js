'use strict';

/**
 * Tests for lib/bdd-mode.js: the one place that decides whether the TRD commands use the Reqnroll/BDD
 * path. BDD stays on by default (what the commands did before it was configurable); these are the ways
 * to opt out. Precedence is flag > ENSEMBLE_BDD > TRD `test_approach` > default (on).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const bddMode = require('../lib/bdd-mode');
const { resolveBdd } = bddMode;

const DEFAULT_MESSAGE = 'Test approach: BDD (Reqnroll) [default; opt out with --no-bdd or ENSEMBLE_BDD=0]';

const roots = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-mode-'));
  roots.push(dir);
  return dir;
}
function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}
function trdWith(root, testApproach) {
  const stamp = testApproach === undefined ? '' : `test_approach: ${testApproach}\n`;
  return write(root, 'docs/TRD/TRD-2026-aaaaaaaa-x.md', `---\ndocument_id: TRD-2026-aaaaaaaa\nstatus: Draft\n${stamp}---\n\n# TRD\n`);
}

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('the default is unchanged: BDD is on', () => {
  test('with nothing set, it is on, and the message says how to opt out', () => {
    expect(resolveBdd({ env: {} })).toEqual({ enabled: true, source: 'default', message: DEFAULT_MESSAGE });
  });

  test('it does not depend on what the repo contains: a repo with no Reqnroll in it is still on', () => {
    expect(resolveBdd({ env: {}, repoRoot: tmp() })).toMatchObject({ enabled: true, source: 'default' });
  });

  test('there is no repo detection left to get wrong', () => {
    expect(bddMode.detectReqnroll).toBeUndefined();
  });

  test('an unstamped TRD, such as one written before this was configurable, is on', () => {
    const root = tmp();
    expect(resolveBdd({ env: {}, trdPath: trdWith(root) })).toMatchObject({ enabled: true, source: 'default' });
  });
});

describe('opting out', () => {
  test.each([
    ['bdd', true],
    ['no-bdd', false],
  ])('flag %s beats env and the TRD stamp', (flag, enabled) => {
    const trd = trdWith(tmp(), enabled ? 'standard' : 'bdd-reqnroll');
    const env = { ENSEMBLE_BDD: enabled ? 'off' : 'on' };
    expect(resolveBdd({ flag, env, trdPath: trd })).toMatchObject({ enabled, source: 'flag' });
  });

  test.each([
    ['1', true], ['true', true], ['ON', true], [' yes ', true],
    ['0', false], ['False', false], ['off', false], ['NO', false],
  ])('env ENSEMBLE_BDD=%j -> %s, and beats the TRD stamp', (value, enabled) => {
    const trd = trdWith(tmp(), enabled ? 'standard' : 'bdd-reqnroll');
    expect(resolveBdd({ env: { ENSEMBLE_BDD: value }, trdPath: trd })).toMatchObject({ enabled, source: 'env' });
  });

  test.each([
    ['bdd-reqnroll', true],
    ['standard', false],
    ['  BDD-Reqnroll ', true],
    ['STANDARD', false],
  ])('TRD test_approach %j -> %s, with no flag or env needed (implement-trd-beads honours create-trd\'s opt-out)', (stamp, enabled) => {
    const trd = trdWith(tmp(), stamp);
    expect(resolveBdd({ env: {}, trdPath: trd })).toMatchObject({ enabled, source: 'trd', evidence: trd.split(path.sep).join('/') });
  });

  test('reads the stamp from a CRLF TRD (this repo\'s TRDs are often Windows-authored)', () => {
    const trd = write(tmp(), 'docs/TRD/crlf.md', '---\r\ndocument_id: TRD-2026-bbbbbbbb\r\ntest_approach: standard\r\n---\r\n\r\n# TRD\r\n');
    expect(resolveBdd({ env: {}, trdPath: trd })).toMatchObject({ enabled: false, source: 'trd' });
  });
});

describe('bad input falls back to the default rather than silently opting out', () => {
  test('an unrecognised ENSEMBLE_BDD is ignored with a warning', () => {
    const out = resolveBdd({ env: { ENSEMBLE_BDD: 'maybe' } });
    expect(out).toMatchObject({ enabled: true, source: 'default' });
    expect(out.warning).toContain("ENSEMBLE_BDD='maybe'");
  });

  test('an empty ENSEMBLE_BDD is simply unset: no warning', () => {
    const out = resolveBdd({ env: { ENSEMBLE_BDD: '  ' } });
    expect(out).toMatchObject({ enabled: true, source: 'default' });
    expect(out.warning).toBeUndefined();
  });

  test('an unrecognised test_approach falls through to the default, with a warning', () => {
    const out = resolveBdd({ env: {}, trdPath: trdWith(tmp(), 'cucumber') });
    expect(out).toMatchObject({ enabled: true, source: 'default' });
    expect(out.warning).toContain("test_approach 'cucumber'");
  });

  test('an unreadable TRD path falls through to the default', () => {
    expect(resolveBdd({ env: {}, trdPath: path.join(tmp(), 'nope.md') })).toMatchObject({ enabled: true, source: 'default' });
  });
});

describe('message', () => {
  test('is the one line the commands print: the warning first, then the approach and its source', () => {
    expect(resolveBdd({ flag: 'bdd', env: {} }).message).toBe('Test approach: BDD (Reqnroll) [flag]');
    expect(resolveBdd({ flag: 'no-bdd', env: {} }).message).toBe('Test approach: standard [flag]');
    expect(resolveBdd({ env: { ENSEMBLE_BDD: '0' } }).message).toBe('Test approach: standard [env]');
    expect(resolveBdd({ env: { ENSEMBLE_BDD: 'maybe' } }).message).toBe(
      `Warning: ENSEMBLE_BDD='maybe' is not one of 1/true/on/yes or 0/false/off/no; ignored\n${DEFAULT_MESSAGE}`
    );
  });
});
