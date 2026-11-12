'use strict';

/**
 * TRD-001-TEST: Sensitive-area resolution (PRD scenarios).
 *
 * Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3 (REQ-003).
 *
 * The Implementation AC tests for the module live in pr-review-paths.test.js.
 * These are the PRD-LEVEL scenarios: a whole PR, graded once, and the verdict
 * every review and approval rule acts on is the thing asserted.
 *
 *   - AC-003-1: an owner declares a path sensitive; a PR touching it is
 *     sensitive for EVERY rule that consults sensitivity. "Every rule" is
 *     pinned two ways: the single answer (`prSensitive`) that callers read,
 *     and a drift guard proving no shipped module decides sensitivity on its
 *     own instead of asking this one.
 *   - AC-003-2: CI workflow definitions, release gates, installers, the
 *     generation pipeline and the constitution are sensitive with no owner
 *     declaration at all -- and stay sensitive when a declaration exists that
 *     does not mention them.
 *   - AC-003-3: a PR that changes the declaration itself is sensitive, and
 *     the declaration in force is the target-branch copy, not the PR's.
 *
 * Each scenario carries a negative control: an ordinary PR that must come
 * back NOT sensitive, so a module that answered "sensitive" to everything
 * would fail here.
 */

const fs = require('fs');
const path = require('path');
const { classifyPaths, DEFAULT_SENSITIVE_PATHS } = require('../lib/pr-review-paths');

const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);

/** The declaration as it exists on the TARGET branch. */
const baseDeclaration = {
  sourceSha: BASE_SHA,
  path: 'REVIEW.md',
  sensitive: ['packages/core/src/auth/**', 'db/migrations/**'],
  high: ['packages/core/src/**'],
};

const review = (changedPaths, declaration = baseDeclaration, baseSha = BASE_SHA) =>
  classifyPaths({ changedPaths, declaration, baseSha });

/**
 * Names that mean "this code is DECIDING whether a path is sensitive":
 * computing a verdict, or standing up its own list of sensitive paths.
 * Carrying a maintainer's configured list as validated DATA (the policy
 * loader's `sensitivePaths` key) is not deciding, and is not matched.
 */
const PATH_SENSITIVITY = /\bprSensitive\b|\bisSensitive\b|(?:SENSITIVE_PATHS|sensitivePaths)\s*=\s*\[/;

/**
 * Does this module source decide path sensitivity without asking
 * pr-review-paths? Comments are stripped first so prose cannot trip or
 * satisfy the guard.
 */
const decidesPathSensitivityAlone = (source) => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (!PATH_SENSITIVITY.test(code)) return false;
  return !/require\(['"]\.\/pr-review-paths['"]\)/.test(code);
};


describe('Scenario AC-003-1: an owner-declared path is sensitive for every rule', () => {
  test('a PR touching a declared path is sensitive, and the declaration entry is named', () => {
    const result = review(['packages/core/src/auth/token.ts']);

    expect(result.ok).toBe(true);
    expect(result.prSensitive).toBe(true);
    expect(result.sensitive).toEqual(['packages/core/src/auth/token.ts']);
    expect(result.paths[0].matchedBy).toBe('packages/core/src/auth/**');
    expect(result.paths[0].source).toBe('declaration');
  });

  test('one declared path among many ordinary ones makes the whole PR sensitive', () => {
    const result = review(['README.md', 'db/migrations/0007_add_index.sql', 'src/ui/button.tsx']);

    expect(result.prSensitive).toBe(true);
    expect(result.sensitive).toEqual(['db/migrations/0007_add_index.sql']);
  });

  test('every consumer reads the same single verdict for the same PR', () => {
    const changed = ['packages/core/src/auth/token.ts', 'README.md'];
    const first = review(changed);
    const second = review([...changed].reverse());

    // Same PR, same answer, whatever order a caller lists the files in.
    expect(first.prSensitive).toBe(true);
    expect(second.prSensitive).toBe(true);
    expect(new Set(first.sensitive)).toEqual(new Set(second.sensitive));
  });

  test('no shipped module decides PATH sensitivity on its own instead of asking this one', () => {
    // Drift guard for "every review and approval rule that consults
    // sensitivity": a rule that invents its own sensitive-path list fails
    // open the moment an owner edits the declaration. Any lib module that
    // reasons about path sensitivity must get it from pr-review-paths.
    // (Secret redaction -- "token", "password" in a payload -- is a
    // different subject and is not matched here.)
    const libDir = path.join(__dirname, '..', 'lib');
    const offenders = fs
      .readdirSync(libDir)
      .filter((file) => file.endsWith('.js') && file !== 'pr-review-paths.js')
      .filter((file) => decidesPathSensitivityAlone(fs.readFileSync(path.join(libDir, file), 'utf8')));

    expect(offenders).toEqual([]);
  });

  test('negative control: the drift guard catches a module that invents its own list', () => {
    const rogue = "const SENSITIVE_PATHS = ['.github/workflows/**'];\nmodule.exports = { SENSITIVE_PATHS };\n";
    const wellBehaved = "const { classifyPaths } = require('./pr-review-paths');\nconst s = classifyPaths(x).prSensitive;\n";
    const unrelated = "const SENSITIVE_KEY_PATTERN = /token|password/i;\n";

    const carriesConfiguredData = "const SIMPLE_KEYS = { sensitivePaths: isPathList };\n";

    expect(decidesPathSensitivityAlone(rogue)).toBe(true);
    expect(decidesPathSensitivityAlone(wellBehaved)).toBe(false);
    expect(decidesPathSensitivityAlone(unrelated)).toBe(false);
    expect(decidesPathSensitivityAlone(carriesConfiguredData)).toBe(false);
  });

  test('negative control: an ordinary PR is not sensitive', () => {
    const result = review(['src/ui/button.tsx', 'README.md']);

    expect(result.prSensitive).toBe(false);
    expect(result.sensitive).toEqual([]);
  });
});

describe('Scenario AC-003-2: default-sensitive areas with no owner declaration', () => {
  const undeclared = (changedPaths) => classifyPaths({ changedPaths, baseSha: BASE_SHA });

  test.each([
    ['CI workflow definitions', '.github/workflows/ci.yml'],
    ['composite CI actions', '.github/actions/setup/action.yml'],
    ['a GitLab pipeline', '.gitlab-ci.yml'],
    ['release gates', 'scripts/validate-all.js'],
    ['installers', 'scripts/install-ensemble.sh'],
    ['the generation pipeline', 'scripts/generate-agents.js'],
    ['the project constitution', 'CONSTITUTION.md'],
  ])('%s are sensitive with no declaration at all', (_label, changedPath) => {
    const result = undeclared([changedPath]);

    expect(result.ok).toBe(true);
    expect(result.declarationSource).toBe('defaults');
    expect(result.prSensitive).toBe(true);
    expect(result.paths[0].source).toBe('default');
    expect(result.paths[0].matchedBy).not.toBeNull();
  });

  test('a declaration that never mentions them does not make them ordinary', () => {
    // The built-in set is a FLOOR: an owner may add areas, never remove these.
    const result = review(['.github/workflows/release.yml']);

    expect(result.declarationSource).toBe('declaration');
    expect(result.prSensitive).toBe(true);
    expect(result.paths[0].source).toBe('default');
  });

  test('a declaration cannot shrink the built-in set by redeclaring an empty list', () => {
    const result = review(['scripts/release-notes.js'], {
      sourceSha: BASE_SHA,
      path: 'REVIEW.md',
      sensitive: [],
      high: [],
    });

    expect(result.prSensitive).toBe(true);
  });

  test('the built-in set is frozen, so no caller can shrink it at runtime', () => {
    expect(Object.isFrozen(DEFAULT_SENSITIVE_PATHS)).toBe(true);
    expect(() => {
      DEFAULT_SENSITIVE_PATHS.push('never');
    }).toThrow();
  });

  test('negative control: an ordinary script outside the default set is not sensitive', () => {
    const result = undeclared(['scripts/dev-helper.js']);

    expect(result.prSensitive).toBe(false);
  });
});

describe('Scenario AC-003-3: the declaration in force is the target-branch copy', () => {
  test('a PR that edits the declaration itself is sensitive', () => {
    const result = review(['REVIEW.md']);

    expect(result.declarationChanged).toBe(true);
    expect(result.prSensitive).toBe(true);
    expect(result.paths[0].source).toBe('declaration-file');
  });

  test('a PR that edits CODEOWNERS is sensitive too', () => {
    const result = review(['.github/CODEOWNERS']);

    expect(result.declarationChanged).toBe(true);
    expect(result.prSensitive).toBe(true);
  });

  test('a PR cannot widen its own review: a head-side declaration is not read', () => {
    const headSide = { ...baseDeclaration, sourceSha: HEAD_SHA, sensitive: ['**'] };
    const result = classifyPaths({
      changedPaths: ['src/ui/button.tsx'],
      declaration: headSide,
      baseSha: BASE_SHA,
    });

    expect(result.declarationSource).toBe('defaults');
    expect(result.warnings).toContain('declaration-not-from-base');
    expect(result.prSensitive).toBe(false);
  });

  test('a PR cannot narrow its own review either: the base declaration still governs', () => {
    // The PR's own copy drops auth from the sensitive list; the review reads
    // the target-branch copy, so the auth change is still sensitive.
    const prCopy = { sourceSha: HEAD_SHA, path: 'REVIEW.md', sensitive: [] };
    const fromHead = classifyPaths({
      changedPaths: ['.github/workflows/ci.yml', 'REVIEW.md'],
      declaration: prCopy,
      baseSha: BASE_SHA,
    });
    const fromBase = review(['.github/workflows/ci.yml', 'REVIEW.md']);

    expect(fromHead.prSensitive).toBe(true);
    expect(fromHead.warnings).toContain('declaration-not-from-base');
    expect(fromBase.prSensitive).toBe(true);
  });

  test('a declaration with no source identity is never trusted', () => {
    const anonymous = { path: 'REVIEW.md', sensitive: ['src/ui/**'] };
    const result = classifyPaths({
      changedPaths: ['src/ui/button.tsx'],
      declaration: anonymous,
      baseSha: BASE_SHA,
    });

    expect(result.declarationSource).toBe('defaults');
    expect(result.warnings).toContain('declaration-not-from-base');
  });

  test('a bare ref as the base is not an object id and is not trusted', () => {
    const result = classifyPaths({
      changedPaths: ['packages/core/src/auth/token.ts'],
      declaration: { ...baseDeclaration, sourceSha: 'main' },
      baseSha: 'main',
    });

    expect(result.declarationSource).toBe('defaults');
    expect(result.warnings).toContain('declaration-not-from-base');
  });

  test('the first PR that introduces the declaration is sensitive, with no base copy', () => {
    const result = classifyPaths({
      changedPaths: ['REVIEW.md'],
      declaration: null,
      baseSha: BASE_SHA,
    });

    expect(result.declarationSource).toBe('defaults');
    expect(result.declarationChanged).toBe(true);
    expect(result.prSensitive).toBe(true);
  });

  test('an unreadable request never returns a clean not-sensitive answer', () => {
    const result = classifyPaths({ changedPaths: 'REVIEW.md', baseSha: BASE_SHA });

    expect(result.ok).toBe(false);
    expect(result.prSensitive).toBe(true);
    expect(result.declarationChanged).toBe(true);
  });

  test('negative control: a PR that touches no declaration file reports none changed', () => {
    const result = review(['src/ui/button.tsx']);

    expect(result.declarationChanged).toBe(false);
    expect(result.prSensitive).toBe(false);
  });
});
