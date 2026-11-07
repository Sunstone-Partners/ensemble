'use strict';

/**
 * pr-review-carry-hash.js -- the deterministic producer of the hashes `planCarry` (pr-review-carry.js, kata qw98) consumes.
 * `prepare` computes no hunk or dependency hash, so without this module an orchestrator could not supply them.
 *
 * It shells out to git (through injectable `deps.git`, the runner of review-prepare-runtime.js `defaultDeps()` that
 * pr-review-prepare.js takes), so it is a module of its own and NOT part of the pure pr-review-cli.js.
 *
 *   hashCitations({ repoRoot?, headSha, citations:[{ id?, file, line?, lines?:[start,end], claim? }] }, deps?)
 *     -> { ok, headSha, candidates:[{ ...the citation verbatim, hunkHash?, depHashes?, hashError? }] }
 *
 * Everything is read AT `headSha` from git objects (`git ls-tree -r` for the tracked paths, `git cat-file --batch` for blob
 * bytes), never from the working tree. Subprocess count is small: one ls-tree plus one cat-file per closure level, blobs
 * cached by path for the whole call.
 *
 * hunkHash  sha256 hex of the cited lines (`line`, or `lines` = [start, end], 1-based inclusive) widened by CONTEXT_LINES (3)
 *           lines on each side (clamped to the file), joined with '\n' (UTF-8). A trailing newline does not add a line.
 * depHashes `{ path: sha256 hex of that file's blob bytes at the head }` for the TRANSITIVE closure of the cited file's
 *           relative imports. References are read exactly as pr-review-import-graph.js `buildImportGraph` does: `referencesOf`
 *           per line, specifier joined to the referencing file's directory (a leading '/' is root-relative) and resolved
 *           against the tracked paths with `resolveTracked`. The cited file itself is never in its own depHashes. Only files
 *           of the analyzed/markup types are read for further references; a `.json` or other data file is hashed, not scanned.
 *           A documentation/data cited file (isSizeable, not analyzed) has `depHashes: {}`.
 *
 * FAIL CLOSED: a citation that cannot be hashed gets NO hunkHash and NO depHashes plus `hashError` (planCarry reads a missing
 * hash as 'hash-missing' => re-verify). Causes: file absent at head, no/invalid line or range (outside the file), the cited
 * file or a closure member holds a computed specifier, the tracked closure exceeds MAX_CLOSURE (200) files, the cited file is source of an unanalyzable type, a
 * path git cannot hand to `cat-file --batch` (contains a newline). Nothing is ever defaulted.
 *
 * HONEST LIMITS: only what the cited file DEPENDS ON is hashed. Its direct callers/importers are NOT (a changed caller does
 * not change the hash; the delta planner's blast radius covers that). Bare npm packages (`require('lodash')`) are out of
 * scope: not hashed, a lockfile change does not invalidate. Resolution is the graph's file-level over-approximation. A
 * relative specifier that resolves to no tracked file is recorded as an ABSENT dependency: key = its normalized joined path,
 * value = sha256('absent'). A string that merely looks like a path is therefore harmless, and a dangling import is
 * invalidated when the file appears (the key set and hashes change). Absent entries are never read and do not count toward
 * the 200-file cap. A specifier climbing above the repository root is ignored. Runtime-built paths are only
 * caught when the call has no plain literal (computed). Only lines are hashed, not syntax: a whitespace edit inside the
 * region changes the hash (toward re-verification).
 */

const crypto = require('crypto');
const {
  referencesOf, joinRelative, dirname, resolveTracked, SCANNED_EXTENSIONS,
} = require('./pr-review-import-graph');
const { isSizeable } = require('./pr-review-delta');
const { isObjectId } = require('./pr-review-scope');

const CONTEXT_LINES = 3;
const MAX_CLOSURE = 200;
const REQUEST_KEYS = ['repoRoot', 'headSha', 'citations'];
const CITATION_KEYS = ['id', 'file', 'line', 'lines', 'claim'];

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const ABSENT_HASH = sha256('absent');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isLine = (value) => Number.isInteger(value) && value >= 1;
const extensionOf = (file) => {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};
/** Files whose text is read for references: code the graph analyzes plus markup (`.json` is scanned by the graph's scan but holds no reference). */
const isScanned = (file) => SCANNED_EXTENSIONS.includes(extensionOf(file)) && extensionOf(file) !== '.json';

class HashError extends Error {}

function defaultGit() {
  return require('./review-prepare-runtime').defaultDeps().git;
}

function gitText(git, repoRoot, args, buffer = false, input) {
  const r = git(args, { cwd: repoRoot, buffer, input });
  if (r.status !== 0) throw new Error(`git ${args[0]} exited ${r.status}: ${String(r.stderr).trim().slice(0, 300)}`);
  return r.stdout;
}

/** Tracked paths at the head. */
function listTracked(git, repoRoot, headSha) {
  const out = gitText(git, repoRoot, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', headSha]);
  return new Set(String(out).split('\0').filter((p) => p !== ''));
}

/** Parses `git cat-file --batch` output for `paths`, in order: Map path -> Buffer | null (missing). */
function parseBatch(buffer, paths) {
  const result = new Map();
  let pos = 0;
  for (const p of paths) {
    const eol = buffer.indexOf(0x0a, pos);
    if (eol === -1) throw new Error('cat-file output is truncated');
    const header = buffer.slice(pos, eol).toString('utf8');
    pos = eol + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      result.set(p, null);
      continue;
    }
    const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (match === null) throw new Error('cat-file header is unreadable');
    const size = Number(match[2]);
    result.set(p, match[1] === 'blob' ? buffer.slice(pos, pos + size) : null);
    pos += size + 1;
  }
  return result;
}

/** Reads every not yet cached path in one cat-file call. A path git cannot name on a line is not read (cached as null). */
function loadBlobs(ctx, paths) {
  const need = [...new Set(paths)].filter((p) => !ctx.blobs.has(p));
  const readable = need.filter((p) => !/[\n\r]/.test(p));
  for (const p of need) if (!readable.includes(p)) ctx.blobs.set(p, null);
  if (readable.length === 0) return;
  // A Buffer: defaultDeps().git passes encoding 'buffer' to spawnSync, which rejects a string `input`.
  const input = Buffer.from(readable.map((p) => `${ctx.headSha}:${p}\n`).join(''));
  const out = gitText(ctx.git, ctx.repoRoot, ['cat-file', '--batch'], true, input);
  for (const [p, content] of parseBatch(Buffer.from(out), readable)) ctx.blobs.set(p, content);
}

function hunkOf(text, citation) {
  let start;
  let end;
  const hasLine = citation.line !== undefined;
  const hasLines = citation.lines !== undefined;
  if (hasLine === hasLines) throw new HashError(hasLine ? 'both line and lines given' : 'no line or lines given');
  if (hasLine) {
    if (!isLine(citation.line)) throw new HashError('line is not a positive integer');
    start = citation.line;
    end = citation.line;
  } else {
    const range = citation.lines;
    if (!Array.isArray(range) || range.length !== 2 || !isLine(range[0]) || !isLine(range[1]) || range[0] > range[1]) {
      throw new HashError('lines is not [start, end] of positive integers');
    }
    [start, end] = range;
  }
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  if (end > rows.length) throw new HashError(`cited line ${end} is outside the file (${rows.length} lines)`);
  return sha256(rows.slice(Math.max(1, start - CONTEXT_LINES) - 1, Math.min(rows.length, end + CONTEXT_LINES)).join('\n'));
}

/**
 * What `file` references: `tracked` (the files it resolves to) and `absent` (the normalized paths of relative specifiers
 * that resolve to no tracked file). A specifier climbing above the repository root is dropped. Throws a HashError on a
 * computed specifier.
 */
function dependenciesOf(ctx, file) {
  const text = ctx.blobs.get(file).toString('utf8');
  const found = new Set();
  const absent = new Set();
  for (const line of text.split('\n')) {
    const references = referencesOf(file, line);
    if (references.computed) throw new HashError(`${file} holds a computed module specifier`);
    for (const spec of references.specifiers) {
      const normalized = joinRelative(spec.startsWith('/') ? '' : dirname(file), spec);
      if (normalized === null) continue;
      const target = resolveTracked(normalized, ctx.tracked);
      if (target === null) absent.add(normalized);
      else if (target !== file) found.add(target);
    }
  }
  return { tracked: [...found].sort(), absent: [...absent].sort() };
}

function depHashesOf(ctx, file) {
  const closure = new Map();
  const seen = new Set([file]);
  let level = isScanned(file) ? [file] : [];
  while (level.length > 0) {
    const next = [];
    for (const member of level) {
      const deps = dependenciesOf(ctx, member);
      for (const gone of deps.absent) closure.set(gone, ABSENT_HASH);
      for (const dep of deps.tracked) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        if (seen.size - 1 > MAX_CLOSURE) throw new HashError(`dependency closure exceeds ${MAX_CLOSURE} files`);
        next.push(dep);
      }
    }
    loadBlobs(ctx, next);
    for (const dep of next) {
      const blob = ctx.blobs.get(dep);
      if (blob === null) throw new HashError(`${dep} cannot be read at the head`);
      closure.set(dep, sha256(blob));
    }
    level = next.filter(isScanned);
  }
  const out = {};
  for (const key of [...closure.keys()].sort()) out[key] = closure.get(key);
  return out;
}

function hashOne(ctx, citation) {
  const { file } = citation;
  if (!isText(file) || file.startsWith('/') || file.includes('\\') || file.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new HashError('file is not a normalized repository-relative path');
  }
  loadBlobs(ctx, [file]);
  const blob = ctx.blobs.get(file);
  if (blob === null || !ctx.tracked.has(file)) throw new HashError(`${file} does not exist at the head`);
  if (!isSizeable(file) && !isScanned(file)) throw new HashError(`${file} is source of a type that cannot be analyzed`);
  const hunkHash = hunkOf(blob.toString('utf8'), citation);
  const depHashes = isScanned(file) ? depHashesOf(ctx, file) : {};
  return { hunkHash, depHashes };
}

/**
 * @param {Object} request  `{ repoRoot?, headSha, citations }`
 * @param {{git?:Function}} [deps]  injected `git(args, { cwd, input, buffer })` -> `{ status, stdout, stderr }`
 * @returns {{ok:true, headSha:string, candidates:Object[]}|{ok:false, error:string}}
 */
function hashCitations(request, deps = {}) {
  if (!isObject(request)) return { ok: false, error: 'request must be a JSON object' };
  const unknown = Object.keys(request).filter((k) => !REQUEST_KEYS.includes(k));
  if (unknown.length > 0) return { ok: false, error: `unknown key(s): ${unknown.join(', ')}` };
  if (!isObjectId(request.headSha)) return { ok: false, error: 'headSha must be a full object id' };
  if (!Array.isArray(request.citations) || !request.citations.every(isObject)) return { ok: false, error: 'citations must be an array of objects' };
  for (const citation of request.citations) {
    const extra = Object.keys(citation).filter((k) => !CITATION_KEYS.includes(k));
    if (extra.length > 0) return { ok: false, error: `unknown citation key(s): ${extra.join(', ')}` };
  }
  const repoRoot = request.repoRoot === undefined ? process.cwd() : request.repoRoot;
  if (!isText(repoRoot)) return { ok: false, error: 'repoRoot must be a non-empty string' };
  const git = deps.git || defaultGit();
  const ctx = { git, repoRoot, headSha: request.headSha, blobs: new Map(), tracked: null };
  try {
    ctx.tracked = listTracked(git, repoRoot, request.headSha);
  } catch (err) {
    return { ok: false, error: `cannot list the tracked files at the head: ${err.message}` };
  }
  const candidates = request.citations.map((citation) => {
    try {
      return { ...citation, ...hashOne(ctx, citation) };
    } catch (err) {
      if (err instanceof HashError) return { ...citation, hashError: err.message };
      return { ...citation, hashError: `git read failed: ${err.message}` };
    }
  });
  return { ok: true, headSha: request.headSha, candidates };
}

module.exports = { hashCitations, CONTEXT_LINES, MAX_CLOSURE };
