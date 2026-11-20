'use strict';
/**
 * The second half of the packaging defect PR #226 began on.
 *
 * `claude plugin install ensemble-full` copies the plugin directory and never runs
 * `npm install`, so a dependency declared in packages/full/package.json is never
 * delivered to an installed plugin. At 8.1.0 `lib/toolchain/config.js` took `js-yaml`
 * and `ajv` unguarded at module scope, and trd-cli.js, toolchain-cli.js,
 * beads-label.js and complexity-analyzer.js all require it, so four entry points died
 * at load and every command shelling to trd-cli.js failed after a clean install.
 *
 * validateFullBundleRequires answers "does this PATH resolve once the install
 * flattens the symlinks". This answers "is this PACKAGE here at all", which no amount
 * of path resolution can see.
 *
 * The scanner tests below are not incidental. The first cut of bareSpecifiers()
 * scanned raw source with a bare `\bfrom\s+['"]...` pattern and reported
 * lib/toolchain/mapping.js as requiring 'this is a literal brace the tool' -- a
 * comment sentence shaped like an import. A bare specifier looks like an English
 * word, where a relative one does not, so prose is a live hazard here and nowhere in
 * the sibling check.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  validateBundleBareRequires,
  bareSpecifiers,
  bareSpecifierFindings,
  specifierPackage,
} = require('../validate-all');
const { VENDORED, TARGET_NON_PACKAGES, checkVendored, fileList } = require('../vendor-bundle-deps');

describe('bareSpecifiers', () => {
  test('finds requires and imports, and ignores relative specifiers', () => {
    const source = [
      "const a = require('js-yaml');",
      "const b = require('./toolchain/config');",
      "import c from 'ajv';",
      "import { d } from 'fast-uri';",
      "import 'side-effect-pkg';",
      "import e from '../lib/matcher';",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual([
      'js-yaml',
      'ajv',
      'fast-uri',
      'side-effect-pkg',
    ]);
  });

  test('ignores a require and an import inside a line comment', () => {
    const source = [
      "// const a = require('not-real');",
      "// import b from 'also-not-real';",
      "const c = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('a line marked validate-bundle-ignore is excused', () => {
    const source = [
      "const a = require('js-yaml');",
      "const b = require('dev-only-pkg'); // validate-bundle-ignore",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('a finding carries the line the specifier sits on', () => {
    const source = [
      "const a = require('js-yaml');",
      '',
      "const b = require('fast-uri');",
    ].join('\n');
    expect(bareSpecifierFindings(source)).toEqual([
      { specifier: 'js-yaml', line: 1 },
      { specifier: 'fast-uri', line: 3 },
    ]);
  });

  test('ignores a require inside a block comment, including a doc comment', () => {
    const source = [
      '/**',
      " * Historically this did require('removed-package') and no longer does.",
      ' */',
      "const a = require('ajv');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['ajv']);
  });

  test('does NOT read prose as an import — the defect that made the first cut unusable', () => {
    // Real shapes from this repo's own comments. A bare `from '...'` pattern matched
    // every one of them and named them as missing dependencies.
    const source = [
      "// the field was renamed from 'rename several fields' in 8.0",
      "// nothing was recognised at all, so it fell back",
      "/* this is a literal brace the tool emits */",
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('reports a specifier once per occurrence, so two call sites are two entries', () => {
    expect(bareSpecifiers("require('ajv');\nrequire('ajv');")).toEqual(['ajv', 'ajv']);
  });

  test('a specifier a generator emits is not a dependency of the file', () => {
    // skills/jest/generate-test.js writes this text into the tests it generates. The
    // dependency belongs to the generated project, not to the bundle that ships the skill.
    const source = [
      "const imports = `import { render } from '@testing-library/react';`;",
      "const more = `require('emitted-only-pkg');`;",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual([]);
  });

  test('a require inside a template expression is a dependency, because it runs', () => {
    expect(bareSpecifiers("const out = `${require('runtime-pkg')}`;")).toEqual(['runtime-pkg']);
  });

  test('a string that holds the word import is not an import', () => {
    expect(bareSpecifiers("const label = 'import the thing';\nconst yaml = require('js-yaml');")).toEqual([
      'js-yaml',
    ]);
  });

  test('a regex literal holding a quote does not hide the require after it', () => {
    // A character scanner that does not know about regex literals reads the quote in
    // /['"]/ as the start of a string and swallows the rest of the line with it.
    const source = [
      "const quote = /['\"]/;",
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('a regex literal holding a backtick does not hide the require after it', () => {
    const source = [
      'const tick = /`/;',
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('a slash that divides is not a regex literal', () => {
    // `a / b / c` is three divisions; reading the second slash as a regex would swallow the
    // rest of the line and hide the require that follows it.
    const source = [
      'const ratio = total / count / 2;',
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('require.resolve names the package it resolves', () => {
    // require.resolve('pkg') throws MODULE_NOT_FOUND without the package, exactly as
    // require('pkg') does.
    expect(bareSpecifiers("const p = require.resolve('js-yaml');")).toEqual(['js-yaml']);
  });

  test('a division does not swallow the require that follows it', () => {
    const source = [
      'const ratio = total / count;',
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('a division by a number does not start a regex literal', () => {
    // `y /2/ z` is a division and a division: reading the second slash as a regex would
    // swallow the rest of the line.
    const source = [
      'const x = y /2/ z;',
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('a regex literal after a closing bracket does not hide the require after it', () => {
    const source = [
      'if (ready) /[\'"]/.test(text);',
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });

  test('a regex literal after a keyword does not hide the require after it', () => {
    // `return /re/` is a regex, not a division, so the quote inside it must not open a string.
    const source = [
      'function check(value) { return /[\'"]/.test(value); }',
      "const yaml = require('js-yaml');",
    ].join('\n');
    expect(bareSpecifiers(source)).toEqual(['js-yaml']);
  });
});

describe('validateBundleBareRequires against a fixture bundle', () => {
  // The bundle's own skills are part of what the install ships, so a skill that loads a
  // package the bundle cannot resolve is a dead skill. Before this check reached every
  // bundle file, `glob` (required by skills/core/detect-stack/detect-stack.js) sat in a
  // reported-but-not-blocking set and every installed plugin answered with no file
  // evidence at all. These tests pin the blocking scope, from both sides.
  const writeBundle = files => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-bare-'));
    for (const [rel, contents] of Object.entries(files)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    return dir;
  };

  const vendoredManifest = JSON.stringify({ name: 'js-yaml', version: '4.1.0' });

  test('a skill that requires a package the bundle cannot resolve fails the check', () => {
    const dir = writeBundle({
      'lib/node_modules/js-yaml/package.json': vendoredManifest,
      'skills/demo/skill.js': [
        "const yaml = require('js-yaml');",
        "const missing = require('not-vendored-pkg');",
      ].join('\n'),
    });
    try {
      const failures = validateBundleBareRequires(dir);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("requires 'not-vendored-pkg'");
      expect(failures[0]).toContain('vendor-bundle-deps.js');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a skill that only EMITS a require is not a dependency of the bundle', () => {
    const dir = writeBundle({
      'lib/node_modules/js-yaml/package.json': vendoredManifest,
      'skills/demo/generate.js': [
        'const out = `import { render } from \'@testing-library/react\';`;',
        'const more = `require(\'emitted-only-pkg\');`;',
      ].join('\n'),
    });
    try {
      expect(validateBundleBareRequires(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a skill that requires a vendored package passes', () => {
    const dir = writeBundle({
      'lib/node_modules/js-yaml/package.json': vendoredManifest,
      'skills/demo/skill.js': "const yaml = require('js-yaml');\nconst fs = require('node:fs');\n",
    });
    try {
      expect(validateBundleBareRequires(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a package installed in the repository does not count as vendored', () => {
    // The bundle is installed on a machine that has the plugin and nothing else, so a package
    // that only exists in the repository's own node_modules is as missing there as one that
    // exists nowhere.
    const dir = writeBundle({
      'lib/node_modules/js-yaml/package.json': vendoredManifest,
      'skills/demo/skill.js': "const minimatch = require('minimatch');\n",
    });
    try {
      const failures = validateBundleBareRequires(dir);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("requires 'minimatch'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a line marked validate-bundle-ignore is excused', () => {
    // A blocking gate needs a way out for a dependency that is genuinely not needed at run
    // time. The marker sits on the line it excuses, so the exception is visible where it
    // applies.
    const dir = writeBundle({
      'lib/node_modules/js-yaml/package.json': vendoredManifest,
      'skills/demo/skill.js':
        "const yaml = require('js-yaml');\n" +
        "const only = require('dev-only-pkg'); // validate-bundle-ignore\n",
    });
    try {
      expect(validateBundleBareRequires(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a builtin subpath is not a dependency the bundle has to vendor', () => {
    const dir = writeBundle({
      'lib/node_modules/js-yaml/package.json': vendoredManifest,
      'skills/demo/skill.js':
        "const fs = require('fs/promises');\nconst path = require('node:path/posix');\n",
    });
    try {
      expect(validateBundleBareRequires(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the failure names the file and the line, so a false positive is one look away', () => {
    const dir = writeBundle({
      'lib/node_modules/js-yaml/package.json': vendoredManifest,
      'skills/demo/skill.js':
        "const yaml = require('js-yaml');\nconst missing = require('not-vendored-pkg');\n",
    });
    try {
      const failures = validateBundleBareRequires(dir);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('skill.js:2');
      expect(failures[0]).toContain("requires 'not-vendored-pkg'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('specifierPackage', () => {
  test('reduces a subpath to its package', () => {
    expect(specifierPackage('ajv/dist/core')).toBe('ajv');
  });

  test('keeps both segments of a scoped package', () => {
    expect(specifierPackage('@testing-library/react')).toBe('@testing-library/react');
    expect(specifierPackage('@aws-sdk/client-s3/dist')).toBe('@aws-sdk/client-s3');
  });

  test('passes a plain package name through', () => {
    expect(specifierPackage('js-yaml')).toBe('js-yaml');
  });
});

describe('validateBundleBareRequires against the real tree', () => {
  test('every bare require in the load-time graph resolves to a builtin or a vendored package', () => {
    expect(validateBundleBareRequires()).toEqual([]);
  });

  test('the vendored tree is present and holds the closure the entry points need', () => {
    // Named as well as swept, because each absence is a dead command rather than a
    // degraded one, and because the tree is gitignored by default: the negation that
    // re-includes it is the last block in .gitignore, and with it anywhere earlier
    // `dist/` won and ajv shipped without its own entry point.
    const vendorDir = path.join(__dirname, '..', '..', 'packages', 'full', 'lib', 'node_modules');
    expect(fs.existsSync(vendorDir)).toBe(true);
    for (const pkg of ['js-yaml', 'argparse', 'ajv', 'fast-uri']) {
      const manifest = path.join(vendorDir, pkg, 'package.json');
      expect(fs.existsSync(manifest)).toBe(true);
      const main = JSON.parse(fs.readFileSync(manifest, 'utf8')).main;
      if (main) {
        expect(fs.existsSync(path.join(vendorDir, pkg, main))).toBe(true);
      }
    }
  });

  test('every vendored package can actually be loaded from the vendored copy', () => {
    // require() rather than a file-existence check: a package whose entry point is
    // present but whose own dependency is not loads here and dies in the install.
    const vendorDir = path.join(__dirname, '..', '..', 'packages', 'full', 'lib', 'node_modules');
    for (const pkg of ['js-yaml', 'ajv']) {
      expect(() => require(path.join(vendorDir, pkg))).not.toThrow();
    }
  });
});

describe('the gitignore negation', () => {
  test('is the last block, so no later pattern can exclude part of the vendored tree', () => {
    // This is the whole bug in one assertion. A negation loses to any later matching
    // pattern; `dist/`, `coverage/` and `*.log` all match paths inside a vendored
        // package. With the block at the top of the file, 216 of 598 files were tracked
    // and ajv/dist/ajv.js was not one of them.
    const lines = fs
      .readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && !l.startsWith('#'));
    const negation = lines.lastIndexOf('!packages/full/lib/node_modules/**');
    expect(negation).toBeGreaterThan(-1);
    const after = lines.slice(negation + 1).filter(l => !l.startsWith('!'));
    expect(after).toEqual([]);
  });
});

describe('checkVendored compares bytes, not names', () => {
  // The names being present and the bytes being the ones npm installed are two
  // questions, and only the first was ever asked. A review of this repo reads the
  // handful of files a PR authors, not 598 files of third-party source, so if the
  // vendored tree drifts from the copy npm verified against the lockfile, nothing but
  // this comparison will say so.

  /**
   * @param {Record<string, Record<string, string>>} packages name -> { relPath: contents }
   * @returns {string} the fixture directory
   */
  const writeTree = packages => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-'));
    for (const [name, files] of Object.entries(packages)) {
      for (const [rel, contents] of Object.entries(files)) {
        const file = path.join(dir, name, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
      }
    }
    return dir;
  };

  const manifestJson = (name, version) => JSON.stringify({ name, version });

  test('the real tree matches the root node_modules', () => {
    expect(checkVendored()).toEqual([]);
  });

  test('an identical fixture pair is clean', () => {
    const files = { 'package.json': manifestJson('left-pad', '1.0.0'), 'index.js': 'module.exports = 1;\n' };
    const source = writeTree({ 'left-pad': files });
    const target = writeTree({ 'left-pad': files });
    try {
      expect(checkVendored({ sourceDir: source, targetDir: target, vendored: ['left-pad'] })).toEqual([]);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('a changed byte in a vendored file is reported with the file named', () => {
    const source = writeTree({
      'left-pad': { 'package.json': manifestJson('left-pad', '1.0.0'), 'index.js': 'module.exports = 1;\n' },
    });
    const target = writeTree({
      'left-pad': { 'package.json': manifestJson('left-pad', '1.0.0'), 'index.js': 'module.exports = 2;\n' },
    });
    try {
      const problems = checkVendored({ sourceDir: source, targetDir: target, vendored: ['left-pad'] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('index.js (content differs)');
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('the version alone staying equal does not clear a changed file', () => {
    // The whole reason this is a content comparison: an altered file is exactly what
    // leaves the version string untouched.
    const source = writeTree({
      pkg: { 'package.json': manifestJson('pkg', '2.3.4'), 'dist/pkg.js': 'ok\n' },
    });
    const target = writeTree({
      pkg: { 'package.json': manifestJson('pkg', '2.3.4'), 'dist/pkg.js': 'ok\n// extra\n' },
    });
    try {
      expect(checkVendored({ sourceDir: source, targetDir: target, vendored: ['pkg'] })).toHaveLength(1);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('a file present only in the vendored copy is reported', () => {
    const source = writeTree({ pkg: { 'package.json': manifestJson('pkg', '1.0.0') } });
    const target = writeTree({
      pkg: { 'package.json': manifestJson('pkg', '1.0.0'), 'smuggled.js': 'require("child_process");\n' },
    });
    try {
      const problems = checkVendored({ sourceDir: source, targetDir: target, vendored: ['pkg'] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('smuggled.js (not in the root copy)');
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('a vendored package nothing in the closure needs is reported', () => {
    const source = writeTree({ pkg: { 'package.json': manifestJson('pkg', '1.0.0') } });
    const target = writeTree({
      pkg: { 'package.json': manifestJson('pkg', '1.0.0') },
      stowaway: { 'package.json': manifestJson('stowaway', '1.0.0') },
    });
    try {
      const problems = checkVendored({ sourceDir: source, targetDir: target, vendored: ['pkg'] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('stowaway: at the vendored root but not in VENDORED');
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  // The extra-entry scan above used to read only non-dot DIRECTORIES, which left the
  // vendored root itself unchecked. Node resolves a bare `require('x')` to
  // `node_modules/x.js` and to `node_modules/.x/` carrying a package.json just as readily
  // as to `node_modules/x/`, so an entry the scan skipped could execute in every install
  // with its bytes never compared -- and `glob` is already a bare require the bundle
  // cannot resolve, so there is a caller waiting for a planted `glob.js`.
  test('a stray top-level FILE at the vendored root is reported', () => {
    const source = writeTree({ pkg: { 'package.json': manifestJson('pkg', '1.0.0') } });
    const target = writeTree({ pkg: { 'package.json': manifestJson('pkg', '1.0.0') } });
    try {
      // `require('glob')` from anything under lib/ resolves this file.
      fs.writeFileSync(path.join(target, 'glob.js'), 'module.exports = () => {};\n');
      const problems = checkVendored({ sourceDir: source, targetDir: target, vendored: ['pkg'] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('glob.js: at the vendored root but not in VENDORED');
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('a dot-prefixed directory at the vendored root is reported', () => {
    const source = writeTree({ pkg: { 'package.json': manifestJson('pkg', '1.0.0') } });
    const target = writeTree({
      pkg: { 'package.json': manifestJson('pkg', '1.0.0') },
      '.glob': { 'package.json': manifestJson('.glob', '1.0.0'), 'index.js': 'module.exports = 1;\n' },
    });
    try {
      const problems = checkVendored({ sourceDir: source, targetDir: target, vendored: ['pkg'] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('.glob: at the vendored root but not in VENDORED');
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('README.md is still allowed, so the scan reports extras rather than everything', () => {
    const source = writeTree({ pkg: { 'package.json': manifestJson('pkg', '1.0.0') } });
    const target = writeTree({ pkg: { 'package.json': manifestJson('pkg', '1.0.0') } });
    try {
      fs.writeFileSync(path.join(target, 'README.md'), 'why this tree exists\n');
      expect(checkVendored({ sourceDir: source, targetDir: target, vendored: ['pkg'] })).toEqual([]);
      // ...and the allowlist is what permits it, not the shape of the name.
      expect(TARGET_NON_PACKAGES.has('README.md')).toBe(true);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('fileList skips the directories the vendoring skips, so the two walks compare', () => {
    const dir = writeTree({
      pkg: {
        'package.json': manifestJson('pkg', '1.0.0'),
        'index.js': 'x\n',
        'test/index.test.js': 'x\n',
        'coverage/lcov.info': 'x\n',
        '.github/workflows/ci.yml': 'x\n',
      },
    });
    try {
      expect(fileList(path.join(dir, 'pkg')).sort()).toEqual(['index.js', 'package.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uri-js and punycode are not vendored: ajv 8.17 resolves URIs with fast-uri', () => {
    // They were vendored at first as "ajv's closure". ajv lists uri-js only in
    // devDependencies, and punycode existed solely for uri-js, so both shipped ~60
    // files of third-party code into every install with no runtime consumer.
    expect(VENDORED).not.toContain('uri-js');
    expect(VENDORED).not.toContain('punycode');
    expect(VENDORED).toContain('fast-uri');
  });
});

describe('stripComments is crude by design', () => {
  test('a tmpdir fixture with only comments yields no specifiers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-requires-'));
    try {
      const file = path.join(dir, 'only-comments.js');
      fs.writeFileSync(file, "// require('ghost')\n/* import x from 'phantom' */\n");
      expect(bareSpecifiers(fs.readFileSync(file, 'utf8'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
