'use strict';

/**
 * Applicable review-rules resolver (TRD-003, REQ-001).
 *
 * Pure: NO shell, NO git calls, NO file reads, NO network, NO timer. The
 * caller supplies the changed path list and the list of rules files that
 * exist AT THE BASE COMMIT; this module only decides which of them apply.
 *
 * Three rules this module exists to make non-negotiable:
 *
 *   1. **Nearest ancestor plus root.** Each changed path is governed by the
 *      rules file in the closest ancestor directory (its own directory
 *      counts) plus the repository root file. A rules file in a sibling
 *      subtree never applies, and a directory name is matched by path
 *      SEGMENT, so `packages/development/REVIEW.md` does not govern
 *      `packages/development-extra/...` (AC-001-1).
 *
 *   2. **A stable order the caller can rely on.** `applied[]` is the
 *      deduplicated union with the root file first, then area files by
 *      directory depth and then alphabetically. The order depends only on
 *      WHICH files apply, never on the order the changed paths or the rules
 *      files arrived in, so two areas with conflicting guidance are always
 *      presented to the skill the same way and the skill -- not this module
 *      -- lets the more restrictive instruction win (AC-001-2). Rule TEXT is
 *      never read here: this module grades paths, so nothing written inside
 *      a rules file can steer it (REQ-024).
 *
 *   3. **Silence is reported, never implied.** When no area file applies,
 *      `notes` says so in words, so a review report can state that no
 *      area-specific rules were found and that repository-wide guidance
 *      applies instead. With no root file either, `applied` is empty and the
 *      same note is present (AC-001-4).
 *
 * Fail-closed: a request this module cannot read -- or a rules list that
 * cannot be shown to come from the base commit when the caller offered shas
 * -- never yields a clean "these rules applied" answer. `ok` is false, the
 * reason is named, `applied` is empty and the "no area-specific rules"
 * note is present, so a caller that ignores `ok` still reports honestly
 * rather than claiming rules were applied.
 */

const { isObjectId } = require('./pr-review-scope');

/** The repository-root rules file every review reads, unless the caller names another. */
const ROOT_RULES_FILE = 'REVIEW.md';

/** The sentence a review report shows when no area file governs the change. */
const NO_AREA_RULES_NOTE =
  'no area-specific rules were found for the changed paths; review proceeds using repository-wide guidance';

/** The sentence shown when the repository has no root rules file. */
const NO_ROOT_NOTE = 'no root rules file exists at the base commit';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/** Repository-relative form: `./a` and `/a` both mean `a`; trailing slashes are dropped. */
function normalizePath(value) {
  let path = String(value).trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  while (path.startsWith('/')) path = path.slice(1);
  while (path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/** The directory part of a normalized path; '' for a file at the repository root. */
const dirnameOf = (path) => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
};

const basenameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/** Directory depth: '' is 0, 'a' is 1, 'a/b' is 2. */
const depthOf = (directory) => (directory === '' ? 0 : directory.split('/').length);

/** Is `directory` the same as, or an ancestor of, `candidate`? Segment-wise, never by prefix. */
const governs = (directory, candidate) =>
  directory === '' || candidate === directory || candidate.startsWith(`${directory}/`);

/** The fail-closed answer: an unreadable request never claims any rules were applied. */
function blocked(reason) {
  return {
    ok: false,
    reason,
    applied: [],
    rootFile: null,
    paths: [],
    multiArea: false,
    ignored: [],
    notes: [NO_AREA_RULES_NOTE],
    warnings: [reason],
  };
}

/**
 * Resolves which review rules files apply to a set of changed paths.
 *
 * @param {Object} input
 * @param {string[]} input.changedPaths     Repository-relative paths changed by the PR.
 * @param {string[]} input.ruleFiles        The rules files PRESENT AT THE BASE COMMIT.
 * @param {string} [input.rulesFileName]    The rules file name; defaults to `REVIEW.md`.
 * @param {string} [input.baseSha]          The review's base commit (full object id).
 * @param {string} [input.sourceSha]        The commit `ruleFiles` was listed from. When either sha
 *   is given, both must be full object ids and equal, or the request is rejected with
 *   `rules-not-from-base`.
 * @returns {{ok:boolean, applied:string[], rootFile:string|null, multiArea:boolean,
 *   paths:Array<{path:string, nearest:string|null, rules:string[]}>, ignored:string[],
 *   notes:string[], warnings:string[], reason?:string}}
 *   `applied` is the deduplicated union, root first; `paths` carries the per-path detail.
 */
function resolveRuleFiles(input) {
  if (!isObject(input)) return blocked('invalid-input');

  const { changedPaths, ruleFiles, rulesFileName, baseSha, sourceSha } = input;
  if (!Array.isArray(changedPaths)) return blocked('invalid-changed-paths');
  if (!changedPaths.every((entry) => isNonEmptyString(entry))) return blocked('invalid-path-entry');
  if (!Array.isArray(ruleFiles)) return blocked('invalid-rule-files');
  if (!ruleFiles.every((entry) => isNonEmptyString(entry))) return blocked('invalid-rule-file-entry');
  if (rulesFileName !== undefined && !isNonEmptyString(rulesFileName)) return blocked('invalid-rules-file-name');

  // --- The rules list must come from the base commit when shas are offered (REQ-024) ---
  if (baseSha !== undefined || sourceSha !== undefined) {
    if (!isObjectId(baseSha) || !isObjectId(sourceSha) || String(sourceSha).toLowerCase() !== String(baseSha).toLowerCase()) {
      return blocked('rules-not-from-base');
    }
  }

  const fileName = rulesFileName === undefined ? ROOT_RULES_FILE : normalizePath(rulesFileName);
  const warnings = [];

  // --- Which rules files exist, and where -------------------------------
  const ignored = [];
  const directories = new Map(); // directory -> rules file path, as normalized
  for (const entry of ruleFiles) {
    const normalized = normalizePath(entry);
    if (basenameOf(normalized) !== fileName) {
      ignored.push(entry);
      continue;
    }
    directories.set(dirnameOf(normalized), normalized);
  }
  if (ignored.length > 0) warnings.push('non-rules-file-ignored');

  const rootFile = directories.has('') ? directories.get('') : null;

  // --- Nearest ancestor per changed path ---------------------------------
  const paths = [];
  const areaFiles = new Set();

  for (const original of changedPaths) {
    const normalized = normalizePath(original);
    const directory = dirnameOf(normalized);

    let nearest = null;
    let nearestDepth = -1;
    for (const [candidate, file] of directories) {
      if (candidate === '') continue; // the root file is added to every path below
      if (!governs(candidate, directory)) continue;
      const candidateDepth = depthOf(candidate);
      if (candidateDepth > nearestDepth) {
        nearest = file;
        nearestDepth = candidateDepth;
      }
    }

    if (nearest !== null) areaFiles.add(nearest);

    const rules = [];
    if (rootFile !== null) rules.push(rootFile);
    if (nearest !== null) rules.push(nearest);

    paths.push({ path: original, nearest, rules });
  }

  // --- Stable union: root first, then area files by depth then name ------
  // The union is taken over the per-path answers, so with no changed paths
  // nothing applies -- there is no review to apply the root file to.
  const sortedAreas = [...areaFiles].sort((left, right) => {
    const byDepth = depthOf(dirnameOf(left)) - depthOf(dirnameOf(right));
    return byDepth !== 0 ? byDepth : left.localeCompare(right);
  });
  const rootApplies = rootFile !== null && paths.length > 0;
  const applied = rootApplies ? [rootFile, ...sortedAreas] : sortedAreas;

  // --- Notes a review report can print verbatim --------------------------
  const notes = [];
  if (sortedAreas.length === 0) notes.push(NO_AREA_RULES_NOTE);
  if (rootFile === null) notes.push(NO_ROOT_NOTE);

  return {
    ok: true,
    applied,
    rootFile,
    multiArea: sortedAreas.length > 1,
    paths,
    ignored,
    notes,
    warnings,
  };
}

module.exports = {
  resolveRuleFiles,
  ROOT_RULES_FILE,
  NO_AREA_RULES_NOTE,
  NO_ROOT_NOTE,
};
