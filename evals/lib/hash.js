'use strict';

/**
 * Content hashes that identify what an eval ran against. Stable across machines and checkouts:
 *   - entries are visited in codepoint order of their name (never locale order) and hashed under POSIX relative paths;
 *   - no mtime, owner or absolute path is hashed; the executable bit is (git tracks it);
 *   - a file with no NUL byte has CRLF and lone CR normalised to LF (a checkout with autocrlf hashes the same);
 *     a file with a NUL byte is binary and hashed as bytes;
 *   - symlinks are never followed: a symlink hashes as its target resolved to a path relative to the hashed tree;
 *     one whose target leaves the tree (or does not exist) is a named error, not silently hashed or followed;
 *   - the only entries ignored are OS junk files listed in IGNORED_NAMES (`.DS_Store`); every other file counts.
 * A missing or unreadable directory throws HashError naming it; there is no "empty hash" fallback.
 *
 * evalHash covers `eval.json`, `rubric.md` (absent is not the same as empty) and `fixture/`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IGNORED_NAMES = new Set(['.DS_Store']);

class HashError extends Error {
  constructor(message) { super(message); this.name = 'HashError'; }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const posix = (p) => p.split(path.sep).join('/');

/** Bytes of a text file with line endings normalised; binary files (a NUL byte) unchanged. */
function normalised(buf) {
  if (buf.includes(0)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n?/g, '\n'), 'latin1');
}

function update(h, tag, rel, data) {
  h.update(`${tag}:${rel}\0`);
  if (data !== undefined) {
    h.update(String(data.length));
    h.update('\0');
    h.update(data);
  }
  h.update('\0');
}

/** Add every entry under `abs` (relative path `rel` inside `top`) to `h`. */
function walk(h, top, rel) {
  const abs = path.join(top, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    throw new HashError(`cannot read directory ${posix(path.relative(top, abs)) || '.'}: ${e.code || e.message}`);
  }
  for (const e of entries.filter((x) => !IGNORED_NAMES.has(x.name)).sort(byName)) {
    const r = path.join(rel, e.name);
    const abse = path.join(top, r);
    if (e.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(abse); } catch { throw new HashError(`symlink ${posix(r)} has no resolvable target`); }
      const realTop = fs.realpathSync(top);
      const relTarget = path.relative(realTop, target);
      if (relTarget === '..' || relTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relTarget)) {
        throw new HashError(`symlink ${posix(r)} points outside the hashed tree; refusing to follow it`);
      }
      update(h, 'link', posix(r), Buffer.from(posix(relTarget) || '.'));
    } else if (e.isDirectory()) {
      update(h, 'dir', posix(r));
      walk(h, top, r);
    } else if (e.isFile()) {
      let buf;
      try { buf = fs.readFileSync(abse); } catch (err) { throw new HashError(`cannot read ${posix(r)}: ${err.code || err.message}`); }
      const exec = (fs.statSync(abse).mode & 0o111) !== 0;
      update(h, exec ? 'xfile' : 'file', posix(r), normalised(buf));
    } else {
      throw new HashError(`unsupported entry ${posix(r)} (not a file, directory or symlink)`);
    }
  }
}

function requireDir(dir, what) {
  let st;
  try { st = fs.lstatSync(dir); } catch { throw new HashError(`${what} not found: ${path.basename(String(dir))}`); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HashError(`${what} is not a real directory: ${path.basename(String(dir))}`);
}

/** Content hash (hex sha256) of the directory tree `dir`. */
function hashTree(dir) {
  requireDir(dir, 'directory');
  const h = crypto.createHash('sha256');
  walk(h, dir, '');
  return h.digest('hex');
}

/** Content hash of a skill directory. */
function skillHash(skillDir) {
  requireDir(skillDir, 'skill directory');
  return hashTree(skillDir);
}

/** Content hash of an eval: `eval.json`, `rubric.md` (marker when absent) and the `fixture/` tree. */
function evalHash(evalDir) {
  requireDir(evalDir, 'eval directory');
  const h = crypto.createHash('sha256');
  const evalJson = path.join(evalDir, 'eval.json');
  if (!fs.existsSync(evalJson)) throw new HashError(`eval.json not found in eval directory ${path.basename(evalDir)}`);
  update(h, 'file', 'eval.json', normalised(fs.readFileSync(evalJson)));
  const rubric = path.join(evalDir, 'rubric.md');
  if (fs.existsSync(rubric)) update(h, 'file', 'rubric.md', normalised(fs.readFileSync(rubric)));
  else update(h, 'absent', 'rubric.md');
  const fixture = path.join(evalDir, 'fixture');
  requireDir(fixture, 'fixture directory');
  walk(h, fixture, '');
  return h.digest('hex');
}

/** `metadata.version` (or a top-level `version`) from SKILL.md front matter, else null. */
function skillVersion(skillDir) {
  const file = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, 'utf8'));
  const v = m && /^\s*version:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(m[1]);
  return v ? v[1] : null;
}

module.exports = { hashTree, skillHash, evalHash, skillVersion, HashError, IGNORED_NAMES };
