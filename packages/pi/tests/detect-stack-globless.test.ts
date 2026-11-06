import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * `glob` is an optional dependency of the detect-stack skill: an out-of-repo
 * copy (a marketplace cache, a manual `cp -r`) has no node_modules above it,
 * because nothing there ran an install. The shipped script must answer in that
 * state instead of throwing - and, the part that matters most, a scan that could
 * not look at a file must never report that file as absent.
 *
 * These tests run the script that ships under `packages/pi/skills`, in a copy
 * with nothing importable above it, which is the state a user is actually in.
 *
 * @module tests/detect-stack-globless
 */

const PI_SKILL = path.resolve(__dirname, '../skills/detect-stack');
const AXES = ['framework', 'test', 'tooling', 'cloud'];

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * A copy of the shipped skill in a bare directory: no node_modules on its path
 * upward, and `glob` is excluded, so `require('glob')` cannot resolve from
 * inside it. The project under scan is a separate directory, which is what makes
 * the whole file system still readable.
 */
function bareCopy(): { dir: string; script: string } {
  const root = tempDir('detect-stack-bare-');
  const target = path.join(root, 'skills', 'detect-stack');
  fs.cpSync(PI_SKILL, target, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
  return { dir: target, script: path.join(target, 'detect-stack.js') };
}

function makeProject(files: Record<string, unknown>): string {
  const dir = tempDir('detect-stack-fixture-');
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** Run `detect(axis, dir)` in a child so the copy's own resolution rules apply. */
function runDetect(script: string, axis: string, projectDir: string): Record<string, any> {
  const driver = path.join(path.dirname(script), `driver-${axis}.js`);
  fs.writeFileSync(
    driver,
    [
      `const mod = require(${JSON.stringify(script)});`,
      `mod.detect(${JSON.stringify(axis)}, ${JSON.stringify(projectDir)}, {})`,
      '  .then((result) => process.stdout.write(JSON.stringify(result)))',
      '  .catch((error) => process.stdout.write(JSON.stringify({ crashed: String(error && error.message) })));',
    ].join('\n')
  );
  const run = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 120000 });
  if (!run.stdout) throw new Error(`detect produced no output: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** React + Jest + docker signals, readable from manifests and plain paths. */
const FIXTURE: Record<string, unknown> = {
  'package.json': {
    name: 'web',
    dependencies: { react: '^18.2.0' },
    devDependencies: { jest: '^29.7.0' },
  },
  'src/App.test.jsx': "import React from 'react';\ntest('renders', () => expect(1).toBe(1));\n",
  'Dockerfile': 'FROM node:20\n',
};

describe('the shipped skill in a copy without glob', () => {
  test('require("glob") really is unresolvable from inside the copy', () => {
    const { dir } = bareCopy();
    const probe = path.join(dir, 'glob-probe.js');
    fs.writeFileSync(
      probe,
      "try { require('glob'); process.stdout.write('resolved'); } catch { process.stdout.write('missing'); }"
    );
    expect(spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 }).stdout).toBe('missing');
  });

  test('the module loads instead of throwing MODULE_NOT_FOUND', () => {
    const { dir } = bareCopy();
    const probe = path.join(dir, 'load-probe.js');
    fs.writeFileSync(probe, "const mod = require('./detect-stack.js'); process.stdout.write(typeof mod.detect);");
    const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 });
    expect(run.stderr).not.toMatch(/Cannot find module|is not defined/);
    expect(run.stdout).toBe('function');
  });

  test.each(AXES)('%s: answers with an envelope instead of crashing', (axis) => {
    const result = runDetect(bareCopy().script, axis, makeProject(FIXTURE));
    expect(result.crashed).toBeUndefined();
    expect(result.axis).toBe(axis);
    expect(typeof result.detected).toBe('boolean');
    expect(result.degraded).toBe('glob-unavailable');
  });

  test('all four axes at once, and the CLI exits 0 or 1 rather than 2', () => {
    const { script } = bareCopy();
    const projectDir = makeProject(FIXTURE);
    const all = runDetect(script, 'all', projectDir);
    expect(all.crashed).toBeUndefined();
    for (const axis of AXES) expect(all.axes[axis].degraded).toBe('glob-unavailable');

    const run = spawnSync(process.execPath, [script, projectDir], { encoding: 'utf8', timeout: 120000 });
    expect([0, 1]).toContain(run.status);
    expect(run.stderr).not.toMatch(/Cannot find module|is not defined/);
    expect(JSON.parse(run.stdout).axes.test.primary).toBe('jest');
  });

  test('--help and a bad path need no dependency at all', () => {
    const { script } = bareCopy();
    expect(spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 30000 }).status).toBe(0);
    const bad = spawnSync(process.execPath, [script, path.join(os.tmpdir(), 'definitely-not-here-xyz')], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/project path is not a directory/);
  });
});
