'use strict';

/**
 * Tests for `trd-cli resolve-bdd` (lib/trd-cli.js), the subcommand create-trd and
 * implement-trd-beads run to learn whether the Reqnroll/BDD path is on. It is on unless opted out.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runResolveBdd } = require('../lib/trd-cli');

const CLI = path.join(__dirname, '..', 'lib', 'trd-cli.js');
const DEFAULT_MESSAGE = 'Test approach: BDD (Reqnroll) [default; opt out with --no-bdd or ENSEMBLE_BDD=0]';

const roots = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-bdd-'));
  roots.push(dir);
  return dir;
}
function trdWith(testApproach) {
  const file = path.join(tmp(), 'TRD.md');
  fs.writeFileSync(file, `---\ntest_approach: ${testApproach}\n---\n# TRD\n`);
  return file;
}
// A child process must not inherit the developer's own ENSEMBLE_BDD.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  if (!extra || !('ENSEMBLE_BDD' in extra)) delete env.ENSEMBLE_BDD;
  return env;
}
function cli(args, env) {
  const res = spawnSync('node', [CLI, 'resolve-bdd', ...args], { encoding: 'utf8', env: cleanEnv(env) });
  return { status: res.status, json: JSON.parse(res.stdout.trim()) };
}

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('runResolveBdd (handler)', () => {
  test('--bdd and --no-bdd map to the flag source', () => {
    expect(runResolveBdd(['--bdd'], {})).toMatchObject({ ok: true, enabled: true, source: 'flag' });
    expect(runResolveBdd(['--no-bdd'], { ENSEMBLE_BDD: '1' })).toMatchObject({ ok: true, enabled: false, source: 'flag' });
  });

  test('both flags together is an error, not a silent pick', () => {
    expect(() => runResolveBdd(['--bdd', '--no-bdd'], {})).toThrow(/mutually exclusive/);
  });

  test('reads ENSEMBLE_BDD from the env it is given, not from process.env', () => {
    expect(runResolveBdd([], { ENSEMBLE_BDD: 'off' })).toMatchObject({ enabled: false, source: 'env' });
    expect(runResolveBdd([], {})).toMatchObject({ enabled: true, source: 'default' });
  });

  test('with nothing set it is on (unchanged), and the message says how to opt out', () => {
    expect(runResolveBdd([], {})).toEqual({ ok: true, enabled: true, source: 'default', message: DEFAULT_MESSAGE });
  });

  test('--trd feeds the TRD stamp into the resolution, so an opt-out recorded by create-trd is honoured', () => {
    expect(runResolveBdd(['--trd', trdWith('standard')], {})).toMatchObject({ enabled: false, source: 'trd' });
    expect(runResolveBdd(['--trd', trdWith('bdd-reqnroll')], {})).toMatchObject({ enabled: true, source: 'trd' });
  });
});

describe('trd-cli resolve-bdd (process)', () => {
  test('prints one JSON object and exits 0', () => {
    const { status, json } = cli([]);
    expect(status).toBe(0);
    expect(json).toEqual({ ok: true, enabled: true, source: 'default', message: DEFAULT_MESSAGE });
  });

  test('ENSEMBLE_BDD in the process environment is honoured', () => {
    expect(cli([], { ENSEMBLE_BDD: '0' }).json).toMatchObject({ enabled: false, source: 'env' });
  });

  test('conflicting flags print {error} and exit 1', () => {
    const { status, json } = cli(['--bdd', '--no-bdd']);
    expect(status).toBe(1);
    expect(json.error).toMatch(/mutually exclusive/);
  });

  test('is listed in the usage line, so a caller can discover it', () => {
    const res = spawnSync('node', [CLI], { encoding: 'utf8' });
    expect(JSON.parse(res.stdout).error).toContain('resolve-bdd');
  });
});
