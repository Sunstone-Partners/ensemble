'use strict';

/**
 * Install smoke test for the packages/full plugin bundle.
 *
 * `claude plugin install` copies the bundle directory with symlinks dereferenced
 * and never runs `npm install`. Everything the shipped skills, agents and
 * commands name under `lib/` must therefore exist as a real file inside the
 * installed tree.
 *
 * The test copies packages/full into a scratch directory (symlink targets
 * copied as real files, exactly what the installer does), then:
 *   1. runs the bundled toolchain CLI and asserts the shipped defaults resolve;
 *   2. asserts every `lib/<file>.js` named by a shipped skill, agent or command
 *      exists in the installed tree and parses;
 *   3. asserts the bundled prd-cli.js knows every subcommand the shipped
 *      skills call;
 *   4. asserts bare npm requires inside the installed tree resolve.
 *
 * The scratch directory lives under the repository (never /tmp — see AGENTS.md)
 * and is removed after the suite.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FULL_DIR = path.join(REPO_ROOT, 'packages', 'full');

/**
 * Bare npm specifiers the installed bundle is allowed to leave unresolved.
 * `glob` is owned by finding 2 (the detect-stack dependency task): the shipped
 * detect-stack skill requires it optionally and degrades when it is absent.
 */
const ALLOWED_UNRESOLVED_BARE_REQUIRES = new Map([
  ['glob', 'finding 2: the detect-stack dependency task owns the glob dependency'],
]);

/** Subcommands the bundle prd-cli.js must know (registry + feature pipeline). */
const REQUIRED_PRD_CLI_SUBCOMMANDS = [
  'list',
  'status',
  'migrate-frontmatter',
  'parse',
  'generate-features',
  'check-drift',
];

/** Shipped toolchain defaults (packages/full/toolchain). */
const SHIPPED_TOOLCHAIN_DEFAULTS = {
  host: 'github',
  workflow: 'plain-git',
  worktree: 'plain-git',
  tracker: 'beads',
  'work-graph': 'beads',
  'ci-local': 'act',
  review: 'coderabbit',
  lint: 'reviewdog',
  'test-runner': 'default',
  'e2e-quality': 'playwright',
  'container-deploy': 'docker-kubectl',
  iac: 'terraform',
  'platform-cloud': 'aws',
  'package-runner': 'npm',
};

/** Directories of the bundle that are not shipped plugin content. */
const NON_CONTENT_DIRS = new Set(['tests']);

const LIB_REF_RE =
  /(?:\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/([A-Za-z0-9._/-]+\.js)|packages\/[a-z0-9-]+\/lib\/([A-Za-z0-9._/-]+\.js))/g;

const BARE_REQUIRE_RE = /require\('([a-z@][A-Za-z0-9._/@-]*)'\)/g;

/** Drop block and line comments so prose about requires is not scanned. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Copy a path into dest with every symlink dereferenced into a real file. */
function copyDereferenced(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    copyDereferenced(fs.realpathSync(src), dest);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (NON_CONTENT_DIRS.has(entry)) continue;
      copyDereferenced(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

/** Collect files under dir, following symlinked directories. */
function walkFiles(dir, out = [], seen = new Set()) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let real;
      try {
        real = fs.realpathSync(filePath);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      walkFiles(filePath, out, seen);
    } else if (stat.isFile()) {
      out.push(filePath);
    }
  }
  return out;
}

/** Every lib file name the shipped skills, agents and commands reference. */
function collectLibReferences(installRoot) {
  const refs = new Map();
  const docs = [
    path.join(installRoot, 'skills'),
    path.join(installRoot, 'agents'),
    path.join(installRoot, 'commands'),
  ];
  for (const doc of docs) {
    for (const file of walkFiles(doc)) {
      if (!/\.(md|json|ya?ml)$/.test(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      let match;
      LIB_REF_RE.lastIndex = 0;
      while ((match = LIB_REF_RE.exec(text)) !== null) {
        const rel = match[1] || match[2];
        if (!rel) continue;
        if (!refs.has(rel)) refs.set(rel, new Set());
        refs.get(rel).add(path.relative(installRoot, file));
      }
    }
  }
  return refs;
}

function runNode(args, options = {}) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

describe('packages/full install smoke test', () => {
  let installRoot;
  let scratchHome;
  let libReferences;

  beforeAll(() => {
    scratchHome = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-full-bundle-smoke-home-'));
    installRoot = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-full-bundle-smoke-'));
    copyDereferenced(FULL_DIR, installRoot);
    libReferences = collectLibReferences(installRoot);
  }, 120000);

  afterAll(() => {
    for (const dir of [installRoot, scratchHome]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the installed bundle resolves the shipped toolchain defaults', () => {
    const stdout = runNode([path.join(installRoot, 'lib', 'toolchain-cli.js'), 'resolve', '--json'], {
      cwd: installRoot,
      env: { ...process.env, HOME: scratchHome, XDG_CONFIG_HOME: path.join(scratchHome, '.config') },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    for (const [category, adapter] of Object.entries(SHIPPED_TOOLCHAIN_DEFAULTS)) {
      expect(parsed.data[category]).toBeDefined();
      expect(parsed.data[category].adapter).toBe(adapter);
      expect(parsed.data[category].source).not.toBe('user');
    }
  }, 60000);

  test('every lib file named by a shipped skill, agent or command is bundled', () => {
    expect(libReferences.size).toBeGreaterThan(0);
    const missing = [];
    for (const [rel, referrers] of libReferences) {
      const target = path.join(installRoot, 'lib', rel);
      if (!fs.existsSync(target)) {
        missing.push(`${rel} (referenced by ${[...referrers].slice(0, 2).join(', ')})`);
        continue;
      }
      expect(() => runNode(['--check', target])).not.toThrow();
    }
    expect(missing).toEqual([]);
  }, 120000);

  test('the bundled prd-cli.js knows every subcommand the bundle ships', () => {
    const unknown = [];
    for (const subcommand of REQUIRED_PRD_CLI_SUBCOMMANDS) {
      let stdout = '';
      let failed = false;
      try {
        stdout = runNode([path.join(installRoot, 'lib', 'prd-cli.js'), subcommand], { cwd: installRoot });
      } catch (err) {
        failed = true;
        stdout = `${err.stdout || ''}${err.stderr || ''}`;
      }
      if (/Unknown subcommand/.test(stdout)) unknown.push(subcommand);
      if (failed && stdout.trim() === '') unknown.push(`${subcommand} (no output)`);
    }
    expect(unknown).toEqual([]);
  }, 60000);

  test('bare npm requires inside the installed bundle resolve', () => {
    const unresolved = new Map();
    for (const file of walkFiles(installRoot)) {
      if (!file.endsWith('.js')) continue;
      if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (file.endsWith('.test.js')) continue;
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      let match;
      BARE_REQUIRE_RE.lastIndex = 0;
      while ((match = BARE_REQUIRE_RE.exec(text)) !== null) {
        const specifier = match[1];
        if (ALLOWED_UNRESOLVED_BARE_REQUIRES.has(specifier)) continue;
        if (require('module').builtinModules.includes(specifier)) continue;
        let resolved = false;
        try {
          require.resolve(specifier, { paths: [path.dirname(file), path.join(installRoot, 'lib')] });
          resolved = true;
        } catch {
          resolved = false;
        }
        if (!resolved) {
          if (!unresolved.has(specifier)) unresolved.set(specifier, new Set());
          unresolved.get(specifier).add(path.relative(installRoot, file));
        }
      }
    }
    const report = [...unresolved.entries()].map(
      ([specifier, files]) => `${specifier} (${[...files].slice(0, 2).join(', ')})`
    );
    expect(report).toEqual([]);
  }, 120000);
});
