'use strict';

/**
 * TRD-007 (TRD-2026-d571763f): the working-tree state the dirty-tree gate reads.
 *
 * The state comes from `workflow.status`, the toolchain capability the skill already uses
 * (`skills/implement-trd-tasks-reference/SKILL.md:17`), so a repository whose `workflow` adapter
 * is not plain git is read through its own adapter rather than through a hardcoded
 * `git status --porcelain`.
 *
 * Tracker-owned `.beads/` paths are not dirt: the tracker rewrites its export during an ordinary
 * run (`docs/guides/beads-tracked-export.md`), and counting that as a dirty tree would refuse
 * every build that followed a tracker sync. Neither is the engine's own saved-choices block in the
 * frontmatter of the TRD being processed (`implement branch --apply` writes it, and the next
 * `implement next` call would otherwise refuse the very change the previous step made): only that
 * file, differing from HEAD in that strictly shaped block and nowhere else, with a branch name that
 * is empty or the branch now checked out. Nothing else is filtered -- the gate exists to stop
 * a build on top of uncommitted work.
 *
 * An unreadable status is `UNAVAILABLE`, never "clean": a gate that passes when it cannot see the
 * tree is a check that cannot fail (Constitution Rule 7).
 */

const fs = require('fs');
const path = require('path');

const { runToolchain, toolchainFailure } = require('./cli-json');
const { currentBranch, gitProbe } = require('./git');
const { isResult, unavailable } = require('./result');

/**
 * The frontmatter key `trd-cli choices-write` upserts (`lib/trd-cli.js` `CHOICES_KEY`). Named here rather than
 * imported because the mounted legacy CLI stays byte-identical to its committed blob.
 */
const CHOICES_KEY = 'ensemble_implement_trd_beads';

/** The tracker-owned directory whose churn is expected during a run. */
const TRACKER_DIR = '.beads';

/**
 * The paths a porcelain line names. `XY path` for an ordinary entry; `XY old -> new` for a
 * rename, where BOTH sides matter -- a rename out of `.beads/` into the tree is dirt.
 * @param {string} line a `git status --porcelain` line
 * @returns {string[]}
 */
function pathsOfLine(line) {
  const status = line.slice(0, 2);
  const body = line.slice(3);
  // Only a rename or a copy carries the ` -> ` separator; an ordinary entry's name may hold
  // ` -> ` itself, and splitting it there would name a path that does not exist.
  const parts = status.includes('R') || status.includes('C') ? splitRenamePaths(body) : [body];
  return parts.map(part => part.trim().replace(/^"(.*)"$/, '$1')).filter(part => part.length > 0);
}

/**
 * Split a porcelain rename field on ` -> `, honouring git's quoting: a ` -> ` inside a quoted
 * name is part of that name, not the separator.
 * @param {string} body the field after the status
 * @returns {string[]}
 */
function splitRenamePaths(body) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted && char === '\\') {
      current += char + (body[index + 1] === undefined ? '' : body[index + 1]);
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && body.startsWith(' -> ', index)) {
      parts.push(current);
      current = '';
      index += 3;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** True when every path the line names belongs to the tracker's own export. */
function isTrackerOwned(line) {
  const paths = pathsOfLine(line);
  if (paths.length === 0) return false;
  return paths.every(entry => entry === TRACKER_DIR || entry.startsWith(`${TRACKER_DIR}/`));
}

/**
 * The saved-choices block of a TRD, read strictly. `trd-cli choices-write` upserts exactly this and
 * nothing else:
 *
 *     ensemble_implement_trd_beads:
 *       branch_name: <name or empty>
 *       use_proposed: <true|false>
 *       stacked_prs: <true|false>
 *
 * as a TOP-LEVEL key of the file's LEADING frontmatter (line 1 is `---`, the next `---` closes it).
 * Anything that is not exactly that -- a nested or indented key, a second block, an extra child
 * line, a missing delimiter -- is ambiguous and answers null, so the caller treats the file as the
 * owner's. Nothing outside the frontmatter is ever looked at.
 *
 * @param {string} text the file
 * @returns {{lines: string[], start: number, branchName: string|null}|null} `start` is -1 and
 *   `branchName` null when there is no block; null when the file cannot be read strictly
 */
function readChoicesBlock(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const close = lines.findIndex((line, index) => index > 0 && line === '---');
  if (close === -1) return null;

  const key = `${CHOICES_KEY}:`;
  let start = -1;
  for (let index = 1; index < close; index += 1) {
    if (!lines[index].includes(CHOICES_KEY)) continue;
    if (lines[index] !== key || start !== -1) return null;
    start = index;
  }
  if (start === -1) return { branchName: null, lines, start };

  const [name, proposed, stacked] = lines.slice(start + 1, start + 4);
  const named = /^ {2}branch_name: ?([^\s'"]*)$/.exec(name === undefined ? '' : name);
  if (
    start + 4 > close ||
    !named ||
    !/^ {2}use_proposed: (true|false)$/.test(proposed === undefined ? '' : proposed) ||
    !/^ {2}stacked_prs: (true|false)$/.test(stacked === undefined ? '' : stacked)
  ) {
    return null;
  }
  // A further indented line would be another child of the block: not what the engine writes.
  if (start + 4 < close && /^[ \t]/.test(lines[start + 4])) return null;
  return { branchName: named[1], lines, start };
}

/** The file's lines with the block's four lines removed, rejoined byte for byte. */
function withoutBlock({ lines, start }) {
  return (start === -1 ? lines : [...lines.slice(0, start), ...lines.slice(start + 4)]).join('\n');
}

/**
 * Whether a porcelain line is the engine's own write of the saved choices into the TRD being
 * processed: an unstaged modification of THAT file, whose content differs from HEAD's in the
 * saved-choices block and nowhere else, and whose block is the bounded shape above with a branch
 * name that is empty or the branch now checked out (the write follows the checkout). Any other
 * file, another TRD, a body edit, a sibling frontmatter key, a staged change or a block that
 * cannot be read strictly is the owner's work, and still dirt.
 *
 * @param {object} call the dispatcher's call object
 * @param {string} line a `git status --porcelain` line
 * @param {string|undefined} trdPath the TRD being processed, project-relative
 * @returns {boolean}
 */
function isEngineChoicesWrite(call, line, trdPath) {
  if (typeof trdPath !== 'string' || trdPath === '' || !/^ M /.test(line)) return false;
  const paths = pathsOfLine(line);
  if (paths.length !== 1 || path.normalize(paths[0]) !== path.normalize(trdPath)) return false;

  const committed = gitProbe(call, ['show', `HEAD:${paths[0]}`]);
  if (isResult(committed) || committed.exit !== 0) return false;
  let current;
  try {
    current = fs.readFileSync(path.resolve(call.projectRoot, paths[0]), 'utf8');
  } catch {
    return false;
  }
  if (current === committed.stdout) return false;

  const before = readChoicesBlock(committed.stdout);
  const after = readChoicesBlock(current);
  if (before === null || after === null || after.start === -1) return false;
  if (withoutBlock(before) !== withoutBlock(after)) return false;

  const branch = currentBranch(call);
  return !isResult(branch) && (after.branchName === '' || after.branchName === branch);
}

/**
 * Read the working tree through the project's `workflow` adapter.
 * @param {object} call the dispatcher's call object
 * @param {{trdPath?: string}} [options] `trdPath` is the TRD being processed: the one file whose
 *   saved-choices write is the engine's own (project-relative). Without it nothing is exempt.
 * @returns {{dirty: boolean, files: string[]}|object} the status, or a tagged engine result when
 *   the status could not be read
 */
function readWorktree(call, options = {}) {
  const result = runToolchain(call, ['run', 'workflow.status']);
  if (!result.json) {
    return unavailable(
      'WORKTREE_STATUS_UNREADABLE',
      `workflow.status produced no JSON result (exit ${result.exitCode})${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`
    );
  }
  if (result.json.ok !== true) return toolchainFailure(result.json.error);
  const files = result.json.data && result.json.data.files;
  if (!Array.isArray(files)) {
    return unavailable(
      'WORKTREE_STATUS_UNREADABLE',
      "workflow.status returned no 'files' array, so the working tree cannot be judged clean or dirty"
    );
  }
  const kept = files
    .map(line => String(line))
    .filter(line => !isTrackerOwned(line) && !isEngineChoicesWrite(call, line, options.trdPath))
    .map(line => pathsOfLine(line).join(' -> '));
  return { dirty: kept.length > 0, files: kept };
}

module.exports = { TRACKER_DIR, readWorktree };
