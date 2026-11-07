'use strict';

/**
 * pr-review-repo.js -- git-backed facts about a PR's commits, READ-ONLY.
 *
 * Rules the next reader relies on:
 * - Every function takes an injected `git(args, { cwd }) -> { status, stdout, stderr }`
 *   (`status` is a number, 127 when git could not be spawned) and a `cwd`, so unit tests
 *   need no process. `defaultGit()` is the ONLY place in this module that touches
 *   `child_process`.
 * - Nothing here writes: no ref, no index, no file. Only plumbing that reads is run.
 * - A caller-supplied revision is never handed to git unless it is plain hex, so a ref
 *   name or an option-looking string can never reach the command line. Paths always come
 *   after `--` (or inside a `<sha>:<path>` object name).
 * - Fail closed: every function that cannot establish a fact says so (`null`, `ok: false`)
 *   instead of guessing.
 */

const fs = require('fs');
const path = require('path');
const { isObjectId } = require('./pr-review-scope');

const HEX_REV = /^[0-9a-f]{7,64}$/i;

/** The real git: no shell, no prompts, no optional locks (so it never writes even a stat cache). */
function defaultGit() {
  const { spawnSync } = require('child_process');
  return (args, { cwd } = {}) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
    });
    if (result.error) return { status: 127, stdout: '', stderr: String(result.error.message) };
    return {
      status: typeof result.status === 'number' ? result.status : 127,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  };
}

const isHexRev = (value) => typeof value === 'string' && HEX_REV.test(value);

/** The full lowercase commit id `rev` names, or `null` (not hex, not found, ambiguous, git failed). */
function resolveCommit(git, cwd, rev) {
  if (!isHexRev(rev)) return null;
  const result = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd });
  if (result.status !== 0) return null;
  const id = String(result.stdout).trim().toLowerCase();
  return isObjectId(id) ? id : null;
}

/** `git merge-base --is-ancestor A B`: true (0), false (1), `null` (anything else, or a bad argument). */
function isAncestor(git, cwd, ancestor, descendant) {
  if (!isHexRev(ancestor) || !isHexRev(descendant)) return null;
  const result = git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

/**
 * Whether `commit` is ON THE PR: it exists, is an ancestor of (or equal to) `headSha`, and
 * is not an ancestor of (or equal to) `baseSha`.
 */
function commitOnPr(git, cwd, { commit, headSha, baseSha } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const full = isHexRev(commit) && commit.length <= 40 ? resolveCommit(git, cwd, commit) : null;
  if (full === null) return fail('commit-not-found');
  const head = resolveCommit(git, cwd, headSha);
  if (head === null) return fail('head-not-found');
  const base = resolveCommit(git, cwd, baseSha);
  if (base === null) return fail('base-not-found');

  const underHead = isAncestor(git, cwd, full, head);
  if (underHead === null) return fail('ancestry-unknown');
  if (underHead === false) return fail('not-an-ancestor-of-head');
  const inBase = isAncestor(git, cwd, full, base);
  if (inBase === null) return fail('ancestry-unknown');
  if (inBase === true) return fail('in-base-history');
  return { ok: true, commit: full };
}

/** The checkout that owns the shared `.git`, also when `cwd` is a linked worktree. */
function primaryWorktree(git, cwd) {
  const fail = (reason) => ({ ok: false, reason });
  const result = git(['rev-parse', '--git-common-dir'], { cwd });
  if (result.status !== 0) return fail('no-primary-worktree');
  const out = String(result.stdout).trim();
  if (out === '') return fail('no-primary-worktree');
  let common;
  try {
    common = fs.realpathSync(path.resolve(cwd, out));
  } catch (error) {
    return fail('no-primary-worktree');
  }
  if (path.basename(common) !== '.git') return fail('no-primary-worktree');
  const primary = path.dirname(common);
  try {
    if (!fs.statSync(primary).isDirectory() || !fs.existsSync(path.join(primary, '.git'))) return fail('no-primary-worktree');
  } catch (error) {
    return fail('no-primary-worktree');
  }
  return { ok: true, path: primary };
}

/** Whether the checkout at `cwd` has `headSha` checked out or built on it. */
function holdsHead(git, cwd, headSha) {
  if (resolveCommit(git, cwd, headSha) === null) return false;
  const result = git(['merge-base', '--is-ancestor', headSha, 'HEAD'], { cwd });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

/** A repository-relative path git can be handed: text, not absolute, no `..` segment, no NUL. */
function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[A-Za-z]:/.test(relPath)) return false;
  return !relPath.split(/[\\/]/).includes('..');
}

/** The text of `relPath` as committed at `sha`; `text: null` when the commit has no such path. */
function readBlobAt(git, cwd, sha, relPath) {
  if (!isSafeRelPath(relPath)) return { ok: false, reason: 'bad-path' };
  const full = resolveCommit(git, cwd, sha);
  if (full === null) return { ok: false, reason: 'commit-not-found' };
  const listed = git(['ls-tree', '-z', full, '--', relPath], { cwd });
  if (listed.status !== 0) return { ok: false, reason: 'git-failed' };
  if (String(listed.stdout) === '') return { ok: true, text: null };
  if (!/^\d+ blob /.test(String(listed.stdout))) return { ok: false, reason: 'not-a-blob' };
  const blob = git(['cat-file', 'blob', `${full}:${relPath}`], { cwd });
  if (blob.status !== 0) return { ok: false, reason: 'git-failed' };
  return { ok: true, text: String(blob.stdout) };
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/**
 * The line numbers, in `from`'s numbering, that `from..to` modified or removed in `file`.
 * `lines: null` means the WHOLE file changed (binary, deleted, created, mode/type change);
 * `[]` means the file did not change.
 */
function changedOldLines(git, cwd, { from, to, file } = {}) {
  if (!isSafeRelPath(file)) return { ok: false, reason: 'bad-path' };
  const a = resolveCommit(git, cwd, from);
  const b = resolveCommit(git, cwd, to);
  if (a === null) return { ok: false, reason: 'from-not-found' };
  if (b === null) return { ok: false, reason: 'to-not-found' };
  const result = git(
    ['--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', a, b, '--', file],
    { cwd }
  );
  if (result.status !== 0) return { ok: false, reason: 'diff-failed' };

  const lines = [];
  let inHunks = false;
  for (const row of String(result.stdout).split('\n')) {
    if (!inHunks) {
      if (/^Binary files /.test(row) || row === 'GIT binary patch') return { ok: true, lines: null };
      if (/^(deleted file mode|new file mode|old mode|new mode) /.test(row)) return { ok: true, lines: null };
      if (row === '--- /dev/null' || row === '+++ /dev/null') return { ok: true, lines: null };
    }
    const match = HUNK.exec(row);
    if (match === null) continue;
    inHunks = true;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let i = 0; i < count; i += 1) lines.push(start + i);
  }
  return { ok: true, lines };
}

module.exports = {
  defaultGit,
  resolveCommit,
  isAncestor,
  commitOnPr,
  primaryWorktree,
  holdsHead,
  readBlobAt,
  changedOldLines
};
