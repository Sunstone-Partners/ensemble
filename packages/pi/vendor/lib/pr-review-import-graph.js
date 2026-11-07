'use strict';

/**
 * pr-review-import-graph.js -- the reverse import graph of a repository head, used to size the
 * blast radius of a delta re-review (kata 801a; docs/plans/pr-review-speedup-plan.md section 3B).
 *
 * Pure: NO shell, NO file reads, NO network. The caller (pr-review-prepare.js, which owns the repo
 * scan) hands in the import-bearing lines it found and the list of every tracked path at the head;
 * this module only turns them into `{ schema, importers, testFiles }`:
 *
 *   importers  target path -> sorted paths that import it. A relative specifier that resolves to a
 *              tracked file is keyed by that file; one that resolves to nothing (the file was
 *              deleted, or is named with an extension the scan does not know) is keyed by the
 *              normalized specifier path itself, so a deleted module still names its importers.
 *   testFiles  every tracked test file (`*.test.*` / `*.spec.*`), for the stem match.
 *
 * Scope, stated rather than hidden: the graph is FILE level and covers JavaScript and TypeScript
 * (`require`, `import ... from`, dynamic `import()` and `export ... from` of a relative path) with RELATIVE
 * specifiers. Bare package specifiers are not edges. It over-approximates "callers of a changed
 * symbol" by "importers of the changed file", which can only ask a reviewer to read MORE.
 */

/** Extensions the scan parses. `planDeltaReview` falls back to a full re-read for opaque code outside this set. */
const ANALYZED_EXTENSIONS = Object.freeze(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx']);
const RESOLVE_EXTENSIONS = Object.freeze([...ANALYZED_EXTENSIONS, '.json']);
/** `.test.js`, `.spec.ts` ... : the names the baseline run of pr-review-prepare.js treats as tests. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SCHEMA = 1;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const posix = (value) => value.replace(/\\/g, '/');

function dirname(file) {
  const i = file.lastIndexOf('/');
  return i < 0 ? '' : file.slice(0, i);
}

function basename(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** Normalizes `dir/spec` without leaving the repository; null when the specifier climbs out of the root. */
function joinRelative(dir, spec) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const segment of posix(spec).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length === 0 ? null : parts.join('/');
}

/** The literal relative specifiers on one source line, in order. Template literals with `${}` are not literals. */
function specifiersOf(text) {
  const found = [];
  const patterns = [
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /^\s*import\s*(['"])([^'"\n]+)\1/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) found.push(match[2]);
  }
  return found.filter((spec) => spec.startsWith('.') && !spec.includes('${'));
}

/** The tracked file a normalized specifier path names, or null. */
function resolveTracked(normalized, tracked) {
  if (tracked.has(normalized)) return normalized;
  for (const ext of RESOLVE_EXTENSIONS) if (tracked.has(normalized + ext)) return normalized + ext;
  for (const ext of RESOLVE_EXTENSIONS) if (tracked.has(`${normalized}/index${ext}`)) return `${normalized}/index${ext}`;
  // TypeScript names the compiled extension in the specifier: './x.js' means './x.ts'.
  const compiled = /^(.*)\.(?:js|mjs|cjs)$/.exec(normalized);
  if (compiled !== null) {
    for (const ext of ['.ts', '.tsx']) if (tracked.has(compiled[1] + ext)) return compiled[1] + ext;
  }
  return null;
}

/**
 * @param {Object} input
 * @param {string[]} input.filePaths  Every tracked path at the head.
 * @param {Array<{path:string, text:string}>} input.lines  The import-bearing source lines the scan found.
 * @returns {{schema:1, importers:Object<string,string[]>, testFiles:string[]}}
 */
function buildImportGraph(input) {
  const filePaths = isObject(input) && Array.isArray(input.filePaths) ? input.filePaths.filter(isText) : [];
  const lines = isObject(input) && Array.isArray(input.lines) ? input.lines : [];
  const tracked = new Set(filePaths);
  const edges = new Map();

  for (const line of lines) {
    if (!isObject(line) || !isText(line.path) || typeof line.text !== 'string') continue;
    for (const spec of specifiersOf(line.text)) {
      const normalized = joinRelative(dirname(line.path), spec);
      if (normalized === null) continue;
      const target = resolveTracked(normalized, tracked) || normalized;
      if (target === line.path) continue;
      if (!edges.has(target)) edges.set(target, new Set());
      edges.get(target).add(line.path);
    }
  }

  const importers = {};
  for (const target of [...edges.keys()].sort()) importers[target] = [...edges.get(target)].sort();
  return { schema: SCHEMA, importers, testFiles: filePaths.filter((file) => TEST_FILE.test(file)).sort() };
}

/** True for a graph `buildImportGraph` could have produced: the planner never trusts a half-read one. */
function isImportGraph(value) {
  if (!isObject(value) || value.schema !== SCHEMA || !isObject(value.importers)) return false;
  if (!Array.isArray(value.testFiles) || !value.testFiles.every(isText)) return false;
  return Object.values(value.importers).every((list) => Array.isArray(list) && list.every(isText));
}

/** The graph keys a changed path may be filed under: itself, without its extension, and the directory of an index file. */
function targetKeys(file) {
  const keys = [file];
  const noExt = file.replace(/\.[^./]+$/, '');
  if (noExt !== file) keys.push(noExt);
  if (/^index$/.test(basename(noExt))) {
    const dir = dirname(noExt);
    if (dir !== '') keys.push(dir);
  }
  return keys;
}

/** The test-file stem match pr-review-prepare.js uses: `thing.js` is tested by `thing.test.js`, `thing.spec.ts`. */
function stemOf(file) {
  return basename(file).replace(/\.[^.]+$/, '');
}

function testStemOf(file) {
  return basename(file).replace(/\.(?:test|spec)\.[^.]+$/, '');
}

module.exports = {
  buildImportGraph,
  isImportGraph,
  targetKeys,
  stemOf,
  testStemOf,
  specifiersOf,
  ANALYZED_EXTENSIONS,
  TEST_FILE,
  SCHEMA,
};
