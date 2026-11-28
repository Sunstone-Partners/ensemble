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
 * every build that followed a tracker sync. Neither is the engine's own saved-choices block in a
 * TRD's frontmatter (`implement branch --apply` writes it, and the next `implement next` call
 * would otherwise refuse the very change the previous step made): only a file that differs from
 * HEAD in that block and nothing else. Nothing else is filtered -- the gate exists to stop
 * a build on top of uncommitted work.
 *
 * An unreadable status is `UNAVAILABLE`, never "clean": a gate that passes when it cannot see the
 * tree is a check that cannot fail (Constitution Rule 7).
 */

const fs = require('fs');
const path = require('path');

const { runToolchain, toolchainFailure } = require('./cli-json');
const { gitProbe } = require('./git');
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
 * The text of a TRD without its saved-choices block: the `ensemble_implement_trd_beads:` key and
 * the indented lines under it, inside the frontmatter. That block is the one thing
 * `implement branch --apply` writes into a TRD (`trd-cli choices-write`).
 * @param {string} text
 * @returns {string}
 */
function withoutChoicesBlock(text) {
  const lines = text.split('\n');
  const open = lines.findIndex(line => line.trim() === '---');
  const close = open === -1 ? -1 : lines.findIndex((line, index) => index > open && line.trim() === '---');
  if (open === -1 || close === -1) return text;
  const keyLine = new RegExp(`^\\s*${CHOICES_KEY}\\s*:`);
  const kept = [];
  let inBlock = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inFrontmatter = index > open && index < close;
    if (inFrontmatter && keyLine.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const child = line.trim() === '' || line.startsWith(' ') || line.startsWith('\t');
      if (inFrontmatter && child) continue;
      inBlock = false;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Whether a porcelain line is the engine's own write of the saved choices into a tracked TRD:
 * an unstaged modification of one Markdown file whose content differs from HEAD's ONLY in the
 * saved-choices block. Anything else about the file -- a body edit, another frontmatter key, a
 * staged change -- is still the owner's work, and still dirt.
 * @param {object} call the dispatcher's call object
 * @param {string} line a `git status --porcelain` line
 * @returns {boolean}
 */
function isEngineChoicesWrite(call, line) {
  if (!/^ M /.test(line)) return false;
  const [relative] = pathsOfLine(line);
  if (!relative || !/\.md$/i.test(relative)) return false;
  const committed = gitProbe(call, ['show', `HEAD:${relative}`]);
  if (isResult(committed) || committed.exit !== 0) return false;
  let current;
  try {
    current = fs.readFileSync(path.resolve(call.projectRoot, relative), 'utf8');
  } catch {
    return false;
  }
  return current !== committed.stdout && withoutChoicesBlock(current) === withoutChoicesBlock(committed.stdout);
}

/**
 * Read the working tree through the project's `workflow` adapter.
 * @param {object} call the dispatcher's call object
 * @returns {{dirty: boolean, files: string[]}|object} the status, or a tagged engine result when
 *   the status could not be read
 */
function readWorktree(call) {
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
    .filter(line => !isTrackerOwned(line) && !isEngineChoicesWrite(call, line))
    .map(line => pathsOfLine(line).join(' -> '));
  return { dirty: kept.length > 0, files: kept };
}

module.exports = { TRACKER_DIR, readWorktree };
