'use strict';

/**
 * TRD-001: Path matching, owner and sensitivity resolution.
 *
 * Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3 (REQ-003).
 *
 * These are the Implementation AC tests for `pr-review-paths.js`. The
 * PRD-scenario tests live in TRD-001-TEST.
 *
 * What is pinned here:
 *   1. an owner-declared sensitive/High list classifies each changed path and
 *      NAMES the declaration entry that matched (AC-003-1);
 *   2. with no owner declaration, CI workflows, release gates, installers,
 *      generation scripts and the constitution are sensitive through the
 *      built-in default set (AC-003-2);
 *   3. a PR that edits the declaration file is itself sensitive, and the
 *      declaration in force is the BASE copy -- a declaration that did not
 *      come from the base commit is rejected, never used (AC-003-3, REQ-024);
 *   4. CODEOWNERS resolution is last-match-wins and a malformed line is
 *      reported and skipped, never guessed.
 *
 * Fail-closed is pinned too: bad request shapes never produce a clean
 * "not sensitive" answer.
 */

const {
  classifyPaths,
  ownersFor,
  matchesPattern,
  DEFAULT_SENSITIVE_PATHS,
  DEFAULT_DECLARATION_PATHS,
} = require('../lib/pr-review-paths');

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** The detail record for one changed path. */
const detailFor = (result, path) => result.paths.find((entry) => entry.path === path);

describe('pr-review-paths: classifyPaths with an owner declaration (AC-003-1)', () => {
  const declaration = {
    path: 'REVIEW.md',
    sourceSha: BASE,
    sensitive: ['packages/core/lib/**', 'src/auth/**'],
    high: ['packages/billing/**'],
  };

  test('each changed path is reported as sensitive or not, and the matching entry is named', () => {
    const result = classifyPaths({
      changedPaths: ['src/auth/token.js', 'docs/readme.md'],
      declaration,
      baseSha: BASE,
    });

    expect(result.ok).toBe(true);
    expect(result.sensitive).toEqual(['src/auth/token.js']);
    expect(detailFor(result, 'src/auth/token.js')).toMatchObject({
      sensitive: true,
      matchedBy: 'src/auth/**',
      source: 'declaration',
    });
    expect(detailFor(result, 'docs/readme.md')).toMatchObject({
      sensitive: false,
      matchedBy: null,
      source: null,
    });
    expect(result.prSensitive).toBe(true);
  });

  test('a declared High path is reported in high[] with the entry that matched', () => {
    const result = classifyPaths({
      changedPaths: ['packages/billing/invoice.js'],
      declaration,
      baseSha: BASE,
    });

    expect(result.high).toEqual(['packages/billing/invoice.js']);
    expect(detailFor(result, 'packages/billing/invoice.js')).toMatchObject({
      high: true,
      highMatchedBy: 'packages/billing/**',
    });
  });

  test('a PR touching no declared or default area is not sensitive', () => {
    const result = classifyPaths({
      changedPaths: ['docs/readme.md', 'src/ui/button.jsx'],
      declaration,
      baseSha: BASE,
    });

    expect(result.ok).toBe(true);
    expect(result.sensitive).toEqual([]);
    expect(result.high).toEqual([]);
    expect(result.declarationChanged).toBe(false);
    expect(result.prSensitive).toBe(false);
  });

  test('a declaration can add to the built-in defaults but never remove one', () => {
    const narrowing = { path: 'REVIEW.md', sourceSha: BASE, sensitive: ['src/auth/**'] };
    const result = classifyPaths({
      changedPaths: ['.github/workflows/release.yml'],
      declaration: narrowing,
      baseSha: BASE,
    });

    expect(result.sensitive).toEqual(['.github/workflows/release.yml']);
    expect(detailFor(result, '.github/workflows/release.yml').source).toBe('default');
  });
});

describe('pr-review-paths: built-in default sensitive set (AC-003-2)', () => {
  const defaultsOnly = (path) => classifyPaths({ changedPaths: [path], declaration: null, baseSha: BASE });

  test.each([
    ['CI workflow definition', '.github/workflows/test.yml'],
    ['CI composite action', '.github/actions/setup/action.yml'],
    ['release gate workflow', '.github/workflows/release-gate.yml'],
    ['release gate script', 'scripts/validate-release-bump.js'],
    ['publish script', 'scripts/publish-plugin.js'],
    ['installer script', 'scripts/install-codex-project.js'],
    ['installer shell script', 'install.sh'],
    ['generation script', 'scripts/generate-markdown.js'],
    ['generation pipeline directory', 'scripts/generate-codex/index.js'],
    ['project constitution', 'docs/standards/constitution.md'],
    ['root constitution', 'CONSTITUTION.md'],
  ])('%s is sensitive with no owner declaration', (_label, path) => {
    const result = defaultsOnly(path);
    expect(result.sensitive).toEqual([path]);
    expect(detailFor(result, path).source).toBe('default');
    expect(typeof detailFor(result, path).matchedBy).toBe('string');
  });

  test('an ordinary source file is not sensitive by default', () => {
    const result = defaultsOnly('packages/development/lib/trd-parser.js');
    expect(result.sensitive).toEqual([]);
    expect(result.prSensitive).toBe(false);
  });

  test('declarationSource reports that no declaration was in force', () => {
    const result = defaultsOnly('docs/readme.md');
    expect(result.declarationSource).toBe('defaults');
    expect(result.ok).toBe(true);
  });

  test('the default set is frozen and non-empty, so a caller cannot shrink it', () => {
    expect(Array.isArray(DEFAULT_SENSITIVE_PATHS)).toBe(true);
    expect(DEFAULT_SENSITIVE_PATHS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DEFAULT_SENSITIVE_PATHS)).toBe(true);
  });
});

describe('pr-review-paths: the declaration file itself and base-commit trust (AC-003-3, REQ-024)', () => {
  const declaration = { path: 'REVIEW.md', sourceSha: BASE, sensitive: ['src/auth/**'] };

  test('a PR that changes the declaration file is sensitive and the change is reported', () => {
    const result = classifyPaths({
      changedPaths: ['REVIEW.md'],
      declaration,
      baseSha: BASE,
    });

    expect(result.declarationChanged).toBe(true);
    expect(result.prSensitive).toBe(true);
    expect(result.sensitive).toEqual(['REVIEW.md']);
    expect(detailFor(result, 'REVIEW.md').source).toBe('declaration-file');
  });

  test('the declaration in force is the base copy -- a head-sourced declaration is rejected', () => {
    const fromHead = { path: 'REVIEW.md', sourceSha: OTHER, sensitive: ['src/vendor/**'] };
    const result = classifyPaths({
      changedPaths: ['src/vendor/lib.js', '.github/workflows/test.yml'],
      declaration: fromHead,
      baseSha: BASE,
    });

    expect(result.declarationSource).toBe('defaults');
    expect(result.warnings).toContain('declaration-not-from-base');
    // The PR's own widened declaration never takes effect...
    expect(result.sensitive).not.toContain('src/vendor/lib.js');
    // ...and the defaults still apply.
    expect(result.sensitive).toContain('.github/workflows/test.yml');
  });

  test('a declaration with no source identity is rejected with the same reason', () => {
    const anonymous = { path: 'REVIEW.md', sensitive: ['src/vendor/**'] };
    const result = classifyPaths({ changedPaths: ['src/vendor/lib.js'], declaration: anonymous, baseSha: BASE });

    expect(result.declarationSource).toBe('defaults');
    expect(result.warnings).toContain('declaration-not-from-base');
    expect(result.sensitive).toEqual([]);
  });

  test('the declaration file is sensitive even when no declaration is in force', () => {
    const result = classifyPaths({ changedPaths: ['REVIEW.md'], declaration: null, baseSha: BASE });
    expect(result.declarationChanged).toBe(true);
    expect(result.prSensitive).toBe(true);
  });

  test('CODEOWNERS counts as a declaration file by default', () => {
    expect(DEFAULT_DECLARATION_PATHS).toContain('.github/CODEOWNERS');
    const result = classifyPaths({ changedPaths: ['.github/CODEOWNERS'], declaration: null, baseSha: BASE });
    expect(result.declarationChanged).toBe(true);
    expect(result.prSensitive).toBe(true);
  });

  test('a declaration naming several files marks any of them as the declaration file', () => {
    const multi = { path: ['REVIEW.md', 'docs/REVIEW.md'], sourceSha: BASE, sensitive: [] };
    const result = classifyPaths({ changedPaths: ['docs/REVIEW.md'], declaration: multi, baseSha: BASE });
    expect(result.declarationChanged).toBe(true);
    expect(detailFor(result, 'docs/REVIEW.md').source).toBe('declaration-file');
  });
});

describe('pr-review-paths: fail-closed request handling', () => {
  test('a missing changedPaths list never returns a clean not-sensitive answer', () => {
    const result = classifyPaths({ declaration: null, baseSha: BASE });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-changed-paths');
    expect(result.prSensitive).toBe(true);
    expect(result.declarationChanged).toBe(true);
  });

  test.each([[null], [undefined], ['a string'], [42], [[]]])('a non-object payload (%p) fails closed', (payload) => {
    const result = classifyPaths(payload);
    expect(result.ok).toBe(false);
    expect(result.prSensitive).toBe(true);
  });

  test('a non-string entry in changedPaths fails closed and names the reason', () => {
    const result = classifyPaths({ changedPaths: ['ok.js', 7], declaration: null, baseSha: BASE });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-path-entry');
    expect(result.prSensitive).toBe(true);
  });

  test('a missing or malformed baseSha rejects the declaration rather than trusting it', () => {
    const declaration = { path: 'REVIEW.md', sourceSha: BASE, sensitive: ['src/vendor/**'] };
    const result = classifyPaths({ changedPaths: ['src/vendor/lib.js'], declaration, baseSha: 'main' });
    expect(result.declarationSource).toBe('defaults');
    expect(result.warnings).toContain('declaration-not-from-base');
    expect(result.sensitive).toEqual([]);
  });

  test('a declaration whose lists are not arrays of strings is rejected, not partially read', () => {
    const declaration = { path: 'REVIEW.md', sourceSha: BASE, sensitive: 'src/**' };
    const result = classifyPaths({ changedPaths: ['src/a.js'], declaration, baseSha: BASE });
    expect(result.declarationSource).toBe('defaults');
    expect(result.warnings).toContain('declaration-malformed');
    expect(result.sensitive).toEqual([]);
  });

  test('a __proto__ payload cannot pollute Object.prototype', () => {
    classifyPaths(JSON.parse('{"changedPaths":["a.js"],"__proto__":{"polluted":true},"baseSha":"' + BASE + '"}'));
    expect({}.polluted).toBeUndefined();
  });
});

describe('pr-review-paths: ownersFor (CODEOWNERS)', () => {
  const codeowners = [
    '# comment line',
    '*            @org/default-team',
    'packages/**  @org/platform @alice',
    'packages/development/lib/** @bob',
    '',
  ].join('\n');

  test('the last matching rule wins and the owner list is returned', () => {
    const result = ownersFor('packages/development/lib/pr-review-paths.js', codeowners);
    expect(result.owners).toEqual(['@bob']);
    expect(result.matchedBy).toBe('packages/development/lib/**');
    expect(result.malformed).toEqual([]);
  });

  test('an earlier rule applies when no later rule matches', () => {
    const result = ownersFor('packages/core/lib/x.js', codeowners);
    expect(result.owners).toEqual(['@org/platform', '@alice']);
    expect(result.matchedBy).toBe('packages/**');
  });

  test('the catch-all rule applies to an otherwise unmatched path', () => {
    const result = ownersFor('README.md', codeowners);
    expect(result.owners).toEqual(['@org/default-team']);
    expect(result.matchedBy).toBe('*');
  });

  test('a malformed line is reported and skipped, never guessed', () => {
    const text = ['packages/** @org/platform', 'docs/**', 'src/** not-an-owner', 'lib/** @ok'].join('\n');
    const result = ownersFor('docs/guide.md', text);

    expect(result.owners).toEqual([]);
    expect(result.matchedBy).toBeNull();
    expect(result.malformed).toEqual([
      { line: 2, text: 'docs/**', reason: 'no-owners' },
      { line: 3, text: 'src/** not-an-owner', reason: 'invalid-owner' },
    ]);
  });

  test('a malformed line never contributes owners to a path it would have matched', () => {
    const text = ['*  @org/default', 'src/** not-an-owner'].join('\n');
    const result = ownersFor('src/a.js', text);
    expect(result.owners).toEqual(['@org/default']);
    expect(result.matchedBy).toBe('*');
  });

  test('an email owner is accepted', () => {
    const result = ownersFor('a.js', '* dev@example.com');
    expect(result.owners).toEqual(['dev@example.com']);
  });

  test('absent or non-string CODEOWNERS text yields no owners rather than throwing', () => {
    expect(ownersFor('a.js', undefined)).toEqual({ owners: [], matchedBy: null, malformed: [] });
    expect(ownersFor('a.js', { not: 'text' })).toEqual({ owners: [], matchedBy: null, malformed: [] });
  });

  test('a non-string path yields no owners rather than throwing', () => {
    expect(ownersFor(null, '* @org/default').owners).toEqual([]);
  });

  test('classifyPaths reports owners for each changed path when CODEOWNERS is supplied', () => {
    const result = classifyPaths({
      changedPaths: ['packages/development/lib/pr-review-paths.js'],
      declaration: null,
      codeowners,
      baseSha: BASE,
    });

    expect(detailFor(result, 'packages/development/lib/pr-review-paths.js').owners).toEqual(['@bob']);
    expect(result.ownersMalformed).toEqual([]);
  });

  test('classifyPaths surfaces malformed CODEOWNERS lines instead of guessing owners', () => {
    const result = classifyPaths({
      changedPaths: ['docs/guide.md'],
      declaration: null,
      codeowners: 'docs/**\n',
      baseSha: BASE,
    });

    expect(detailFor(result, 'docs/guide.md').owners).toEqual([]);
    expect(result.ownersMalformed).toEqual([{ line: 1, text: 'docs/**', reason: 'no-owners' }]);
    expect(result.warnings).toContain('codeowners-malformed');
  });
});

describe('pr-review-paths: glob matching', () => {
  test.each([
    ['src/**', 'src/a/b/c.js', true],
    ['src/**', 'src/a.js', true],
    ['src/**', 'srcx/a.js', false],
    ['src/*', 'src/a.js', true],
    ['src/*', 'src/a/b.js', false],
    ['*.yml', 'a.yml', true],
    ['*.yml', 'deep/dir/a.yml', true],
    ['/*.yml', 'deep/dir/a.yml', false],
    ['/*.yml', 'a.yml', true],
    ['docs/', 'docs/a/b.md', true],
    ['docs/', 'docsx/b.md', false],
    ['a?c.js', 'a-c.js', true],
    ['a?c.js', 'abbc.js', false],
    // A wildcard segment matches only what it spells out...
    ['scripts/generate-*', 'scripts/generate-codex/index.js', false],
    ['scripts/generate-*/**', 'scripts/generate-codex/index.js', true],
    // ...while a literal directory name covers everything beneath it.
    ['src/auth', 'src/auth/token.js', true],
    ['src/auth', 'src/authz/token.js', false],
    ['docs/a/b.md', 'docs/a/b.md', true],
  ])('pattern %p vs path %p -> %p', (pattern, path, expected) => {
    expect(matchesPattern(pattern, path)).toBe(expected);
  });

  test('a regex metacharacter in a pattern is matched literally, not executed', () => {
    expect(matchesPattern('a+b.js', 'a+b.js')).toBe(true);
    expect(matchesPattern('a+b.js', 'aab.js')).toBe(false);
    expect(matchesPattern('a.js', 'axjs')).toBe(false);
  });

  test('a non-string pattern or path never matches', () => {
    expect(matchesPattern(null, 'a.js')).toBe(false);
    expect(matchesPattern('a.js', null)).toBe(false);
  });

  test('a leading ./ in a changed path is normalized before matching', () => {
    const result = classifyPaths({ changedPaths: ['./.github/workflows/test.yml'], declaration: null, baseSha: BASE });
    expect(result.sensitive).toEqual(['./.github/workflows/test.yml']);
  });
});
