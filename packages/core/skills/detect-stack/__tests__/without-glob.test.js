const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const SCRIPT = path.join(SKILL_DIR, 'detect-stack.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const AXES = ['framework', 'test', 'tooling', 'cloud'];
const tempDirs = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A throwaway project directory containing { relativePath: content }. */
function makeProject(files = {}) {
  const dir = tempDir('detect-stack-fixture-');
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/**
 * A copy of the skill in a bare directory: nothing on its path upward has a
 * node_modules, so `require('glob')` from inside it cannot resolve - the state
 * that made the script throw at load time.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.withGlob] - also vendor the dependency, as a published package would
 */
function publishedCopy({ withGlob = false } = {}) {
  const root = tempDir('detect-stack-published-');
  const target = path.join(root, 'skills', 'detect-stack');
  fs.cpSync(SKILL_DIR, target, {
    recursive: true,
    filter: source => !source.includes(`${path.sep}__tests__${path.sep}`)
  });
  if (withGlob) {
    fs.cpSync(path.join(REPO_ROOT, 'node_modules', 'glob'), path.join(target, 'node_modules', 'glob'), {
      recursive: true
    });
  }
  return { root, dir: target, script: path.join(target, 'detect-stack.js') };
}

/** Run the script as a subprocess from `cwd`, the way the skill's instructions do. */
function runCli(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, timeout: 60000 });
}

/** Run `detect('all')` in a child process that loads the copy by absolute path. */
function runDetect(copy, projectPath) {
  const driver = path.join(copy.root, 'driver.js');
  fs.writeFileSync(
    driver,
    [
      `const mod = require(${JSON.stringify(path.join(copy.dir, 'detect-stack.js'))});`,
      `mod.detect('all', ${JSON.stringify(projectPath)}, {})`,
      '  .then(result => process.stdout.write(JSON.stringify(result)))',
      '  .catch(error => {',
      '    process.stdout.write(JSON.stringify({ crashed: String(error && error.message) }));',
      '    process.exitCode = 9;',
      '  });'
    ].join('\n')
  );
  const run = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 60000 });
  expect(run.stderr).not.toMatch(/Cannot find module 'glob'/);
  const parsed = JSON.parse(run.stdout);
  expect(parsed.crashed).toBeUndefined();
  return parsed;
}

/**
 * Can a plain node script *located at the same depth as detect-stack.js* resolve
 * `glob` from there? Node walks up from the file being executed, so the probe has
 * to sit beside the script under test rather than one directory above it.
 */
function globResolvesFrom(copy) {
  const probe = path.join(copy.dir, 'probe-glob.js');
  fs.writeFileSync(probe, "process.stdout.write(require.resolve('glob'));");
  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 });
  return run.status === 0;
}

// React + Jest, provable from package.json alone; the .jsx source and the
// Dockerfile are the extra evidence the file-walk signals would have added.
const FIXTURE_FILES = {
  'package.json': {
    name: 'web',
    dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
    devDependencies: { jest: '^29.7.0' }
  },
  'src/App.jsx': [
    "import React, { useState } from 'react';",
    'export default function App() {',
    '  const [count] = useState(0);',
    '  return <div>{count}</div>;',
    '}'
  ].join('\n'),
  Dockerfile: 'FROM node:20\n'
};

describe('the reproduction is real', () => {
  test('glob resolves in the repo install but not from the bare copy', () => {
    expect(globResolvesFrom(publishedCopy({ withGlob: true }))).toBe(true);
    expect(globResolvesFrom(publishedCopy())).toBe(false);
  });

  test('loading the copy at HEAD would have thrown MODULE_NOT_FOUND', () => {
    // The guard's contract: the failure happened at require time, before any
    // argument parsing, so a load that succeeds is the primary regression.
    const copy = publishedCopy();
    const probe = path.join(copy.dir, 'load-probe.js');
    fs.writeFileSync(probe, "const mod = require('./detect-stack.js'); process.stdout.write(typeof mod.detect);");
    const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000 });
    expect(run.stderr).not.toMatch(/Cannot find module 'glob'/);
    expect(run.stdout).toBe('function');
  });
});

describe('detect-stack CLI run from the copy (glob unresolvable)', () => {
  test('the script loads and prints an envelope instead of crashing', () => {
    const { script } = publishedCopy();
    const projectDir = makeProject(FIXTURE_FILES);
    const run = runCli(script, [projectDir], projectDir);
    expect(run.stderr).not.toMatch(/Cannot find module/);
    expect([0, 1]).toContain(run.status);
    const json = JSON.parse(run.stdout);
    expect(json.axes.test.primary).toBe('jest');
    expect(json.axes.tooling.degraded).toBe('glob-unavailable');
  });

  test.each(AXES)('--axis=%s still answers, with the degradation flagged', (axis) => {
    const { script } = publishedCopy();
    const projectDir = makeProject(FIXTURE_FILES);
    const run = runCli(script, [projectDir, `--axis=${axis}`], projectDir);
    expect([0, 1]).toContain(run.status);
    const json = JSON.parse(run.stdout);
    expect(json.axis).toBe(axis);
    expect(json.degraded).toBe('glob-unavailable');
  });

  test('--help needs no dependency at all', () => {
    const { script } = publishedCopy();
    const run = runCli(script, ['--help'], process.cwd());
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Usage: detect-stack\.js/);
  });

  test('an unknown option exits 2 with a usage line, not a stack trace', () => {
    const { script } = publishedCopy();
    const run = runCli(script, ['--nope'], process.cwd());
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/Unknown option/);
    expect(run.stderr).not.toMatch(/at Object\.<anonymous>/);
  });

  test('a bad project path still exits 2 naming the path', () => {
    const { script } = publishedCopy();
    const projectDir = makeProject(FIXTURE_FILES);
    const run = runCli(script, [path.join(projectDir, 'nope')], projectDir);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/project path is not a directory/);
  });
});

describe('a degraded scan is not more confident than a complete scan', () => {
  test.each(AXES)('the %s axis reaches the same answer without glob as with it', (axis) => {
    const projectDir = makeProject(FIXTURE_FILES);
    const full = runDetect(publishedCopy({ withGlob: true }), projectDir);
    const degraded = runDetect(publishedCopy(), projectDir);
    expect(degraded.axes[axis].detected).toBe(full.axes[axis].detected);
    expect(degraded.axes[axis].primary).toBe(full.axes[axis].primary);
    expect(degraded.axes[axis].confidence).toBeLessThanOrEqual(full.axes[axis].confidence);
  });

  test('a complete scan reports no degradation at all', () => {
    const full = runDetect(publishedCopy({ withGlob: true }), makeProject(FIXTURE_FILES));
    for (const axis of AXES) {
      expect(full.axes[axis].degraded).toBeUndefined();
    }
  });

  test('a degraded scan is flagged on every axis that reads files', () => {
    const degraded = runDetect(publishedCopy(), makeProject(FIXTURE_FILES));
    for (const axis of AXES) {
      expect(degraded.axes[axis].degraded).toBe('glob-unavailable');
    }
  });

  test('the tooling axis stays flagged on a repeat call served from its cache', () => {
    // detectTooling caches its whole result per project path and the cache is
    // keyed only by path, so an entry stored during a degraded run must not
    // replay as a clean result - in the same process or in a later one.
    const projectDir = makeProject(FIXTURE_FILES);
    const degraded = publishedCopy();
    const first = runDetect(degraded, projectDir);
    expect(first.axes.tooling.degraded).toBe('glob-unavailable');
    const again = runDetect(degraded, projectDir);
    expect(again.axes.tooling.degraded).toBe('glob-unavailable');
  });
});
