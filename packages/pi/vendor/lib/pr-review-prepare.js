'use strict';

/**
 * pr-review-prepare.js -- one deterministic preparation step per reviewed head
 * (kata b1rv; docs/plans/pr-review-speedup-plan.md section 3D).
 *
 * Every reviewer and verifier used to re-derive the frozen snapshot, the diffs,
 * the facts and a baseline test run on its own. This module builds them ONCE per
 * head, under a persistent per-run directory, and returns paths plus content
 * hashes (the verdict carry-over needs the hashes):
 *
 *   <stateRoot>/<runId>/<headSha>/
 *     snapshot/        the tree of HEAD, exported with `git archive` (never a live
 *                      worktree), verified object-for-object against the tree, then
 *                      made read-only. NOTHING is ever written inside it: the
 *                      baseline test run works on a scratch copy of its own.
 *     range.diff       BASE...HEAD
 *     delta.diff       lastReviewedSha..HEAD, only when `chooseReviewRange` says
 *                      mode=delta; otherwise ABSENT, with the reason in the manifest
 *     facts.json       policy, tier inputs, `paths` classification inputs and result,
 *                      changedPaths from `git diff --numstat -z --no-renames`
 *     probe.js         a ready probe runner agents `require()` (load a snapshot
 *                      module, run a command read-only, `chain` end-to-end steps)
 *     baseline.json    the baseline run of the relevant test files: command, files,
 *     baseline.log     exit code, captured output
 *     manifest.json    inputs + the sha256 of every artifact above
 *
 * FAIL CLOSED: an unreadable base or head, a head that moved while the step ran, a
 * snapshot that is not exactly the head's tree, an unreadable guidance file or a
 * baseline that could not be started all return `{ ok:false, status:'PREPARE_FAILED',
 * reason, stage, detail }` and publish NOTHING. Artifacts are built in a staging
 * directory and renamed into place only after every check passed, so a reader never
 * sees a half-built or stale-looking directory as current.
 *
 * IDEMPOTENT: a second call for the same head and inputs finds the published
 * directory, re-verifies every recorded hash (and the snapshot), and returns the
 * same hashes without running anything. A directory that no longer verifies is
 * rebuilt, never trusted.
 *
 * This module drives git and touches the filesystem, so it lives OUTSIDE
 * pr-review-cli.js (whose lib modules are pure). Every process it starts goes through
 * the injectable `deps` (`deps.git`, `deps.run`), the pattern of local-ci-runner.js;
 * the real ones live in review-prepare-runtime.js, so no pr-review-*.js file spawns.
 * It does not define a timing primitive: spans belong to the run-trace recorder.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chooseReviewRange, isObjectId } = require('./pr-review-scope');
const { loadPolicy } = require('./pr-review-policy');
const { classifyPaths } = require('./pr-review-paths');
const { redact } = require('./pr-review-state');
const { defaultDeps, PROBE_SOURCE, DEFAULT_BASELINE_TIMEOUT_MS } = require('./review-prepare-runtime');

const SCHEMA_VERSION = 1;
const DEFAULT_STATE_ROOT = path.join('.ensemble', 'pr-review', 'prepare');
/** The test files the default baseline runs: jest-style names. A caller with another runner passes `testFiles`/`testCommand`. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CODEOWNERS_LOCATIONS = Object.freeze(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
const RULES_FILE = 'REVIEW.md';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** An expected, named failure: becomes the fail-closed error object. */
class PrepareError extends Error {
  constructor(reason, stage, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.stage = stage;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ helpers */

function gitOk(deps, args, opts, reason, stage, detail) {
  const r = deps.git(args, opts);
  if (r.status !== 0) {
    throw new PrepareError(reason, stage, `${detail} (git ${args[0]} exited ${r.status}: ${String(r.stderr).trim().slice(0, 300)})`);
  }
  return r;
}

function commitReadable(deps, repoRoot, sha) {
  return deps.git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: repoRoot }).status === 0;
}

/** Parses `git diff --numstat -z --no-renames`: `<added>\t<deleted>\t<path>\0` per file, the path verbatim (it may hold tabs or newlines). */
function parseNumstatZ(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = text.indexOf('\0', i);
    if (end === -1) throw new Error('numstat output is not NUL-terminated');
    const record = text.slice(i, end);
    i = end + 1;
    const a = record.indexOf('\t');
    const b = a === -1 ? -1 : record.indexOf('\t', a + 1);
    if (a === -1 || b === -1) throw new Error('numstat record has no path');
    const added = record.slice(0, a);
    const deleted = record.slice(a + 1, b);
    const file = record.slice(b + 1);
    if (file === '') throw new Error('numstat record has an empty path');
    const binary = added === '-' && deleted === '-';
    if (!binary && !(/^\d+$/.test(added) && /^\d+$/.test(deleted))) throw new Error('numstat counts are not numbers');
    out.push({ path: file, added: binary ? null : Number(added), deleted: binary ? null : Number(deleted), binary });
  }
  return out;
}

/** `git ls-tree -r -z` -> [{mode, type, sha, path}] in git's own order. */
function parseLsTreeZ(text) {
  const out = [];
  for (const record of text.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const meta = tab === -1 ? [] : record.slice(0, tab).split(' ');
    if (meta.length !== 3) throw new Error('ls-tree record is unreadable');
    out.push({ mode: meta[0], type: meta[1], sha: meta[2], path: record.slice(tab + 1) });
  }
  return out;
}

function blobId(algo, content) {
  const hash = crypto.createHash(algo);
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest('hex');
}

function walkFiles(root) {
  const found = [];
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), child);
      else found.push(child);
    }
  };
  visit(root, '');
  return found;
}

/**
 * The snapshot must be EXACTLY the head's tree: every regular file and symlink the tree lists is there with the
 * blob id git gave it (and the owner-exec bit git recorded), and nothing else is. `git archive` can silently differ
 * (export-ignore, export-subst, eol attributes, a case-insensitive checkout folding two names into one); that is
 * a failed snapshot, never a close-enough one. Returns the digest of the tree listing.
 */
function verifySnapshot(snapshotDir, entries, algo) {
  const expected = new Map();
  for (const e of entries) if (e.type === 'blob') expected.set(e.path, e);
  const problems = [];
  const present = new Set(walkFiles(snapshotDir));
  for (const rel of present) if (!expected.has(rel)) problems.push(`unexpected file ${JSON.stringify(rel)}`);
  for (const [rel, entry] of expected) {
    if (!present.has(rel)) { problems.push(`missing ${JSON.stringify(rel)}`); continue; }
    const abs = path.join(snapshotDir, rel);
    const stat = fs.lstatSync(abs);
    if (entry.mode === '120000') {
      if (!stat.isSymbolicLink() || blobId(algo, Buffer.from(fs.readlinkSync(abs))) !== entry.sha) problems.push(`symlink differs ${JSON.stringify(rel)}`);
      continue;
    }
    if (!stat.isFile() || blobId(algo, fs.readFileSync(abs)) !== entry.sha) {
      problems.push(`content differs ${JSON.stringify(rel)}`);
    } else if (((stat.mode & 0o100) !== 0) !== (entry.mode === '100755')) {
      problems.push(`executable bit differs ${JSON.stringify(rel)}`);
    }
    if (problems.length >= 5) break;
  }
  if (problems.length > 0) throw new PrepareError('snapshot-mismatch', 'snapshot', problems.slice(0, 5).join('; '));
  return sha256(entries.map((e) => `${e.mode}\0${e.path}\0${e.sha}\n`).join(''));
}

function makeReadOnly(dir) {
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (!entry.isSymbolicLink()) fs.chmodSync(abs, fs.statSync(abs).mode & ~0o222);
    }
    fs.chmodSync(current, fs.statSync(current).mode & ~0o222);
  };
  visit(dir);
}

function makeWritable(dir) {
  if (!fs.existsSync(dir)) return;
  const visit = (current) => {
    fs.chmodSync(current, fs.statSync(current).mode | 0o700);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (!entry.isSymbolicLink()) fs.chmodSync(abs, fs.statSync(abs).mode | 0o600);
    }
  };
  visit(dir);
}

/** Removes a prepared (possibly read-only) directory. */
function removePrepared(dir) {
  makeWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

/* ------------------------------------------------------------------- input */

function readInput(options) {
  if (!isObject(options)) throw new PrepareError('invalid-input', 'input', 'options must be an object');
  const { repoRoot, runId } = options;
  if (!isText(repoRoot) || !path.isAbsolute(repoRoot)) throw new PrepareError('invalid-input', 'input', 'repoRoot must be an absolute path');
  if (!isText(runId)) throw new PrepareError('invalid-input', 'input', 'runId is required');
  for (const key of ['baseSha', 'headSha', 'mergeBaseSha', 'prBaseSha', 'parentPhaseTipSha', 'lastReviewedSha']) {
    const value = options[key];
    if (value !== undefined && value !== null && value !== '' && !isObjectId(value)) {
      throw new PrepareError('invalid-input', 'input', `${key} is not a full object id`);
    }
  }
  if (options.remediationShas !== undefined && !(Array.isArray(options.remediationShas) && options.remediationShas.every(isObjectId))) {
    throw new PrepareError('invalid-input', 'input', 'remediationShas must be a list of full object ids');
  }
  if (options.testFiles !== undefined && !(Array.isArray(options.testFiles) && options.testFiles.every(isText))) {
    throw new PrepareError('invalid-input', 'input', 'testFiles must be a list of repository-relative paths');
  }
  if (options.testCommand !== undefined && !(Array.isArray(options.testCommand) && options.testCommand.length > 0 && options.testCommand.every(isText))) {
    throw new PrepareError('invalid-input', 'input', 'testCommand must be a non-empty argv array (test files are appended)');
  }
  if (options.headRef !== undefined && !isText(options.headRef)) throw new PrepareError('invalid-input', 'input', 'headRef must be a ref name');
  return options;
}

function resolveStateDir(options, headSha) {
  const stateRoot = path.resolve(options.repoRoot, options.stateRoot || DEFAULT_STATE_ROOT);
  const dir = path.join(stateRoot, safeSegment(options.runId), headSha.toLowerCase());
  if (!dir.startsWith(stateRoot + path.sep)) throw new PrepareError('invalid-input', 'input', 'the run directory is outside the state root');
  return { stateRoot, dir };
}

/* --------------------------------------------------------------- the steps */

function readBaseText(deps, repoRoot, baseSha, rel, warnings) {
  const listing = gitOk(deps, ['ls-tree', '-z', baseSha, '--', rel], { cwd: repoRoot }, 'base-guidance-unreadable', 'facts', `cannot list ${rel} at the base`);
  const entries = parseLsTreeZ(listing.stdout).filter((e) => e.path === rel);
  if (entries.length === 0) return null;
  const [entry] = entries;
  if (entry.type !== 'blob' || entry.mode === '120000') {
    warnings.push(`${rel}-not-a-regular-file`);
    return null;
  }
  const blob = gitOk(deps, ['cat-file', 'blob', entry.sha], { cwd: repoRoot, buffer: true }, 'base-guidance-unreadable', 'facts', `cannot read ${rel} at the base`);
  return blob.stdout.toString('utf8');
}

function chooseRange(deps, input, scopeInput) {
  const request = { ...scopeInput };
  if (isText(input.lastReviewedSha)) {
    request.lastReviewedSha = input.lastReviewedSha;
    request.remediationShas = input.remediationShas || [];
    const log = deps.git(['rev-list', '--parents', `${input.lastReviewedSha}..${scopeInput.headSha}`], { cwd: input.repoRoot });
    if (log.status === 0) {
      request.commits = log.stdout.split('\n').filter((line) => line !== '').map((line) => {
        const [sha, ...parents] = line.split(' ');
        return { sha, parents };
      });
    }
  }
  const decision = chooseReviewRange(request);
  if (!decision.ok) {
    throw new PrepareError('range-unresolved', 'range', `review-range blocked: missing ${decision.missing.join(',') || '-'}, invalid ${decision.invalid.join(',') || '-'}`);
  }
  return decision;
}

function relatedTests(testPaths, changedPaths) {
  const picked = new Map();
  const stem = (file) => path.posix.basename(file).replace(/\.[^.]+$/, '');
  const byStem = new Map();
  for (const t of testPaths) {
    const key = path.posix.basename(t).replace(/\.(?:test|spec)\.[^.]+$/, '');
    if (!byStem.has(key)) byStem.set(key, []);
    byStem.get(key).push(t);
  }
  for (const file of changedPaths) {
    if (TEST_FILE.test(file)) {
      if (testPaths.includes(file)) picked.set(file, 'changed');
    } else if (byStem.has(stem(file))) {
      for (const t of byStem.get(stem(file))) if (!picked.has(t)) picked.set(t, `tests ${file}`);
    }
  }
  return [...picked.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, why]) => ({ file, why }));
}

function resolveBaselineCommand(options, nodeModules) {
  if (options.testCommand) return options.testCommand.slice();
  const jest = nodeModules ? path.join(nodeModules, 'jest', 'bin', 'jest.js') : null;
  if (jest && fs.existsSync(jest)) return [process.execPath, jest, '--ci', '--runTestsByPath'];
  return null;
}

function linkNodeModules(workDir, nodeModules) {
  if (nodeModules) fs.symlinkSync(nodeModules, path.join(workDir, 'node_modules'), 'dir');
}

function makeArchive(deps, repoRoot, headSha, tarPath) {
  gitOk(deps, ['archive', '--format=tar', '-o', tarPath, headSha], { cwd: repoRoot }, 'snapshot-failed', 'snapshot', 'git archive failed');
}

function extractArchive(deps, repoRoot, tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = deps.run(['tar', '-xf', tarPath, '-C', destDir], { cwd: repoRoot, timeoutMs: 5 * 60 * 1000 });
  if (r.status !== 0) throw new PrepareError('snapshot-failed', 'snapshot', `tar extraction failed: ${String(r.stderr || r.spawnError).trim().slice(0, 300)}`);
}

function runBaseline({ deps, options, staging, tarPath, entries, changedPaths, headSha, nodeModules }) {
  const testPaths = entries.filter((e) => e.type === 'blob' && TEST_FILE.test(e.path)).map((e) => e.path);
  let selection;
  if (options.testFiles) {
    const known = new Set(entries.map((e) => e.path));
    const missing = options.testFiles.filter((f) => !known.has(f));
    if (missing.length > 0) throw new PrepareError('baseline-not-run', 'baseline', `testFiles not in the head tree: ${missing.slice(0, 3).join(', ')}`);
    selection = [...new Set(options.testFiles)].sort().map((file) => ({ file, why: 'requested' }));
  } else {
    selection = relatedTests(testPaths, changedPaths);
  }
  const base = { headSha, selection };
  if (selection.length === 0) {
    return { record: { ...base, ran: false, reason: 'no-test-files', command: null, exitCode: null, timedOut: false }, log: '' };
  }
  const command = resolveBaselineCommand(options, nodeModules);
  if (command === null) {
    throw new PrepareError('baseline-not-run', 'baseline', 'no test runner: pass testCommand, or make jest resolvable from the repository node_modules');
  }
  const workDir = path.join(staging, '.baseline-work');
  try {
    extractArchive(deps, options.repoRoot, tarPath, workDir);
    linkNodeModules(workDir, nodeModules);
    const argv = [...command, ...selection.map((s) => s.file)];
    const r = deps.run(argv, {
      cwd: workDir,
      env: { ...process.env, CI: 'true', ...(nodeModules ? { NODE_PATH: nodeModules } : {}) },
      timeoutMs: options.baselineTimeoutMs || DEFAULT_BASELINE_TIMEOUT_MS,
    });
    if (r.spawnError) throw new PrepareError('baseline-not-run', 'baseline', `could not start ${argv[0]}: ${r.spawnError}`);
    const log = redact(`# stdout\n${r.stdout}\n# stderr\n${r.stderr}\n`);
    return {
      record: {
        ...base, ran: true, command: argv.slice(0, command.length), exitCode: r.status, signal: r.signal, timedOut: r.timedOut,
      },
      log,
    };
  } finally {
    removePrepared(workDir);
  }
}

/* --------------------------------------------------------------- publishing */

function describeFile(root, rel) {
  const data = fs.readFileSync(path.join(root, rel));
  return { path: rel, sha256: sha256(data), bytes: data.length };
}

function writeArtifact(staging, rel, data) {
  fs.writeFileSync(path.join(staging, rel), data);
}

function fingerprintOf(input, scope, range) {
  return sha256(JSON.stringify({
    v: SCHEMA_VERSION,
    baseSha: scope.baseSha,
    headSha: scope.headSha,
    mode: range.mode,
    lastReviewedSha: range.mode === 'delta' ? range.lastReviewedSha : null,
    testFiles: input.testFiles ? [...input.testFiles].sort() : null,
    testCommand: input.testCommand || null,
  }));
}

/** Re-verifies a published directory: manifest, every recorded hash, and the snapshot. Returns the manifest, or null. */
function readPublished(deps, input, dir, fingerprint, entries, algo) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(manifest) || manifest.schema !== SCHEMA_VERSION || manifest.fingerprint !== fingerprint) return null;
  for (const [name, artifact] of Object.entries(manifest.artifacts || {})) {
    if (name === 'snapshot') continue;
    try {
      if (sha256(fs.readFileSync(path.join(dir, artifact.path))) !== artifact.sha256) return null;
    } catch {
      return null;
    }
  }
  try {
    const digest = verifySnapshot(path.join(dir, 'snapshot'), entries, algo);
    if (!manifest.artifacts.snapshot || manifest.artifacts.snapshot.sha256 !== digest) return null;
  } catch {
    return null;
  }
  return manifest;
}

function resultFrom(manifest, dir, reused) {
  const manifestSha256 = sha256(fs.readFileSync(path.join(dir, 'manifest.json')));
  const hashes = {};
  for (const [name, artifact] of Object.entries(manifest.artifacts)) hashes[name] = artifact.sha256;
  return {
    ok: true,
    status: 'PREPARED',
    reused,
    dir,
    manifestPath: path.join(dir, 'manifest.json'),
    manifestSha256,
    headSha: manifest.headSha,
    baseSha: manifest.baseSha,
    mode: manifest.range.mode,
    range: manifest.range,
    artifacts: Object.fromEntries(Object.entries(manifest.artifacts).map(([name, a]) => [name, { ...a, path: path.join(dir, a.path) }])),
    absent: manifest.absent,
    hashes,
    baseline: manifest.baseline,
  };
}

/* ------------------------------------------------------------------- entry */

/**
 * Prepares one head for review.
 *
 * @param {Object} options
 * @param {string} options.repoRoot          Absolute path of the git repository holding base and head.
 * @param {string} options.runId             Names the persistent per-run directory.
 * @param {string} options.baseSha           Everything `resolveReviewScope` takes: baseSha, mergeBaseSha, prBaseSha,
 * @param {string} options.headSha             parentPhaseTipSha. Full object ids only.
 * @param {string} [options.headRef]         A ref that must resolve to `headSha` when the step starts and again right
 *   before anything is published; a head that moved in between is `head-moved`.
 * @param {string} [options.lastReviewedSha] The head the previous round reviewed; with `remediationShas` it decides
 *   (via `chooseReviewRange`) whether a `delta.diff` is produced.
 * @param {string[]} [options.remediationShas]
 * @param {string} [options.stateRoot]       Default `<repoRoot>/.ensemble/pr-review/prepare`.
 * @param {string[]} [options.testFiles]     Baseline test files; default: the test files the PR changed or whose
 *   source it changed.
 * @param {string[]} [options.testCommand]   Baseline argv prefix (files are appended); default: the repository's jest.
 * @param {number} [options.baselineTimeoutMs]
 * @param {string} [options.nodeModules]     node_modules the baseline and the probe resolve third-party requires from;
 *   default `<repoRoot>/node_modules` when present.
 * @param {Object} [injected]                `{ git, run }` replacements (see defaultDeps).
 * @returns {Object} `{ ok:true, status:'PREPARED', reused, dir, artifacts, hashes, ... }` or
 *   `{ ok:false, status:'PREPARE_FAILED', reason, stage, detail }`.
 */
function prepareReview(options, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  let staging = null;
  try {
    return prepare(options, deps, (dir) => { staging = dir; });
  } catch (err) {
    if (err instanceof PrepareError) {
      return { ok: false, status: 'PREPARE_FAILED', reason: err.reason, stage: err.stage, detail: redact(err.detail) };
    }
    return { ok: false, status: 'PREPARE_FAILED', reason: 'unexpected-error', stage: 'unknown', detail: redact(err && err.message ? err.message : String(err)) };
  } finally {
    if (staging !== null) removePrepared(staging);
  }
}

function prepare(rawOptions, deps, setStaging) {
  const options = readInput(rawOptions);
  const { repoRoot } = options;

  const scopeInput = {
    baseSha: options.baseSha,
    headSha: options.headSha,
    mergeBaseSha: options.mergeBaseSha,
    prBaseSha: options.prBaseSha,
    parentPhaseTipSha: options.parentPhaseTipSha,
  };
  // Resolve base and head exactly as the review-range module does, so prepare and review can never disagree.
  const range = chooseRange(deps, options, scopeInput);
  const { baseSha, headSha } = range;

  if (!commitReadable(deps, repoRoot, baseSha)) throw new PrepareError('base-unreadable', 'input', `the base commit ${baseSha} cannot be read in ${repoRoot}`);
  if (!commitReadable(deps, repoRoot, headSha)) throw new PrepareError('head-unreadable', 'input', `the head commit ${headSha} cannot be read in ${repoRoot}`);

  const headStable = (reason) => {
    if (!isText(options.headRef)) return;
    const r = deps.git(['rev-parse', '--verify', '--quiet', `${options.headRef}^{commit}`], { cwd: repoRoot });
    const now = r.status === 0 ? String(r.stdout).trim().toLowerCase() : null;
    if (now !== headSha.toLowerCase()) {
      throw new PrepareError(reason, 'head-check', `${options.headRef} is ${now === null ? 'unreadable' : now}, not the head ${headSha} being prepared`);
    }
  };
  headStable('head-mismatch');

  const { stateRoot, dir } = resolveStateDir(options, headSha);
  const nodeModules = (() => {
    const candidate = options.nodeModules || path.join(repoRoot, 'node_modules');
    return fs.existsSync(candidate) ? fs.realpathSync(candidate) : null;
  })();

  const algo = String(gitOk(deps, ['rev-parse', '--show-object-format'], { cwd: repoRoot }, 'snapshot-failed', 'snapshot', 'cannot read the object format').stdout).trim() === 'sha256' ? 'sha256' : 'sha1';
  const lsTree = gitOk(deps, ['ls-tree', '-r', '-z', '--full-tree', headSha], { cwd: repoRoot }, 'snapshot-failed', 'snapshot', 'cannot list the head tree');
  let entries;
  try {
    entries = parseLsTreeZ(lsTree.stdout);
  } catch (err) {
    throw new PrepareError('snapshot-failed', 'snapshot', err.message);
  }
  const treeSha = String(gitOk(deps, ['rev-parse', `${headSha}^{tree}`], { cwd: repoRoot }, 'snapshot-failed', 'snapshot', 'cannot resolve the head tree').stdout).trim();

  const fingerprint = fingerprintOf(options, { baseSha, headSha }, range);

  // ---- already prepared? re-verify every hash before trusting it ---------
  if (fs.existsSync(dir)) {
    const manifest = readPublished(deps, options, dir, fingerprint, entries, algo);
    if (manifest !== null) {
      headStable('head-moved');
      return resultFrom(manifest, dir, true);
    }
    removePrepared(dir);
  }

  // ---- build in staging ---------------------------------------------------
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(stateRoot, '.staging-'));
  setStaging(staging);

  const tarPath = path.join(staging, '.head.tar');
  const snapshotDir = path.join(staging, 'snapshot');
  makeArchive(deps, repoRoot, headSha, tarPath);
  extractArchive(deps, repoRoot, tarPath, snapshotDir);
  const snapshotDigest = verifySnapshot(snapshotDir, entries, algo);

  const diffFlags = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/'];
  const rangeDiff = gitOk(deps, [...diffFlags, `${baseSha}...${headSha}`], { cwd: repoRoot, buffer: true }, 'range-diff-failed', 'diff', `git diff ${baseSha}...${headSha} failed`);
  writeArtifact(staging, 'range.diff', rangeDiff.stdout);

  const absent = {};
  if (range.mode === 'delta') {
    const deltaDiff = gitOk(deps, [...diffFlags, `${range.lastReviewedSha}..${headSha}`], { cwd: repoRoot, buffer: true }, 'delta-diff-failed', 'diff', `git diff ${range.lastReviewedSha}..${headSha} failed`);
    writeArtifact(staging, 'delta.diff', deltaDiff.stdout);
  } else {
    absent['delta.diff'] = range.reason;
  }

  const numstat = gitOk(deps, ['diff', '--numstat', '-z', '--no-renames', baseSha, headSha], { cwd: repoRoot }, 'changed-paths-failed', 'facts', 'git diff --numstat failed');
  let files;
  try {
    files = parseNumstatZ(numstat.stdout);
  } catch (err) {
    throw new PrepareError('changed-paths-failed', 'facts', err.message);
  }
  const changedPaths = files.map((f) => f.path);

  const warnings = [];
  const reviewText = readBaseText(deps, repoRoot, baseSha, RULES_FILE, warnings);
  let codeowners = null;
  let codeownersPath = null;
  for (const candidate of CODEOWNERS_LOCATIONS) {
    codeowners = readBaseText(deps, repoRoot, baseSha, candidate, warnings);
    if (codeowners !== null) { codeownersPath = candidate; break; }
  }
  const policy = loadPolicy({ text: reviewText, baseSha, sourceSha: baseSha });
  const declaration = { sourceSha: baseSha, sensitive: policy.policy.sensitivePaths, high: policy.policy.highPaths };
  const pathsInput = { changedPaths, declaration, codeowners: codeowners === null ? undefined : codeowners, baseSha };
  const classification = classifyPaths(pathsInput);

  const facts = {
    schema: SCHEMA_VERSION,
    repoRoot,
    nodeModules,
    baseSha,
    headSha,
    treeSha,
    range: { mode: range.mode, range: range.range, fullRange: range.fullRange, reason: range.reason, lastReviewedSha: range.lastReviewedSha || null, unvouched: range.unvouched },
    diffForm: { range: `${baseSha}...${headSha}`, changedPaths: `git diff --numstat -z --no-renames ${baseSha} ${headSha}` },
    changedPaths,
    numstat: files,
    totals: {
      files: files.length,
      added: files.reduce((n, f) => n + (f.added || 0), 0),
      deleted: files.reduce((n, f) => n + (f.deleted || 0), 0),
      binary: files.filter((f) => f.binary).length,
    },
    guidance: { sourceSha: baseSha, rulesFile: RULES_FILE, rulesFilePresent: reviewText !== null, codeownersPath, warnings },
    policy,
    pathsInput,
    paths: classification,
    // `assignTier` takes the classifier agent's `kinds` plus this classification; the kinds are the agent's to supply.
    tierInputs: { paths: classification, changedPaths, kinds: null },
  };
  writeArtifact(staging, 'facts.json', `${JSON.stringify(facts, null, 2)}\n`);
  writeArtifact(staging, 'probe.js', PROBE_SOURCE);

  const baseline = runBaseline({ deps, options, staging, tarPath, entries, changedPaths, headSha, nodeModules });
  writeArtifact(staging, 'baseline.json', `${JSON.stringify(baseline.record, null, 2)}\n`);
  writeArtifact(staging, 'baseline.log', baseline.log);

  // ---- the head must still be the head: nothing is published for a moved one
  headStable('head-moved');

  const artifacts = { snapshot: { path: 'snapshot', treeSha, sha256: snapshotDigest } };
  for (const name of ['range.diff', 'delta.diff', 'facts.json', 'probe.js', 'baseline.json', 'baseline.log']) {
    if (fs.existsSync(path.join(staging, name))) artifacts[name] = describeFile(staging, name);
  }
  fs.rmSync(tarPath, { force: true });
  const manifest = {
    schema: SCHEMA_VERSION,
    fingerprint,
    runId: options.runId,
    baseSha,
    headSha,
    range: facts.range,
    artifacts,
    absent,
    baseline: { ran: baseline.record.ran, exitCode: baseline.record.exitCode, timedOut: baseline.record.timedOut, reason: baseline.record.reason || null },
  };
  writeArtifact(staging, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  makeReadOnly(snapshotDir);
  try {
    fs.renameSync(staging, dir);
  } catch (err) {
    // A concurrent preparer for the same head published first: use its directory if it verifies.
    const existing = ['ENOTEMPTY', 'EEXIST'].includes(err.code) ? readPublished(deps, options, dir, fingerprint, entries, algo) : null;
    if (existing === null) throw new PrepareError('publish-failed', 'publish', `cannot publish ${dir}: ${err.message}`);
    return resultFrom(existing, dir, true);
  }
  setStaging(null);
  return resultFrom(manifest, dir, false);
}

module.exports = {
  prepareReview,
  removePrepared,
  parseNumstatZ,
  verifySnapshot,
  parseLsTreeZ,
  defaultDeps,
  PROBE_SOURCE,
  SCHEMA_VERSION,
  DEFAULT_STATE_ROOT,
};
