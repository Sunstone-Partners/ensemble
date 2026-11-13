'use strict';

/**
 * Run outcome from grader results. Deterministic checks alone decide the verdict; judged checks
 * (`judged: true`) are reported separately as a score and never change it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const envlib = require('./env');
const hash = require('./hash');
const { supportedRuntimes } = require('./runners');

/** `{ pass, verdict, judgedScore, judgeModel }` for a list of grader results. */
function summarizeRun(graders) {
  const deterministic = graders.filter((g) => !g.judged);
  const judged = graders.filter((g) => g.judged);
  const scores = judged.filter((g) => typeof g.score === 'number').map((g) => g.score);
  const pass = deterministic.length > 0 && deterministic.every((g) => g.pass);
  const judgeModel = (judged.find((g) => g.judgeModel) || {}).judgeModel || null;
  return {
    pass,
    verdict: pass ? 'pass' : 'fail',
    judgedScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    judgeModel,
  };
}

/**
 * Which copy was evaluated: the package directory loaded as the plugin (never a copy), the skill's content hash,
 * and whether the working tree differs from the committed copy (`git status --porcelain` on the package: the
 * whole package is loaded, so an edit anywhere in it counts). `workingTreeDiffers` is null when the repository
 * is not a git checkout. The installed (marketplace) copy is not inspected.
 */
function evaluatedCopy({ repoRoot, packageName, skill }) {
  const packagePath = path.join(repoRoot, 'packages', packageName);
  const skillDir = path.join(packagePath, 'skills', skill);
  const git = (args) => spawnSync('git', [...envlib.GIT_HARDEN, '-C', repoRoot, ...args], { encoding: 'utf8', env: envlib.gitEnv() });
  let workingTreeDiffers = null;
  let changedFiles = [];
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status === 0 && inside.stdout.trim() === 'true') {
    const st = git(['status', '--porcelain', '--untracked-files=all', '--', path.relative(repoRoot, packagePath)]);
    if (st.status === 0) {
      changedFiles = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
      workingTreeDiffers = changedFiles.length > 0;
    }
  }
  return {
    packagePath: path.relative(repoRoot, packagePath),
    skillHash: hash.skillHash(skillDir), // throws HashError naming the problem (missing skill directory, escaping symlink)
    skillVersion: hash.skillVersion(skillDir),
    workingTreeDiffers,
    changedFiles: changedFiles.slice(0, 20),
  };
}

/** One line stating the evaluated copy. */
function describeCopy(c) {
  const tree = c.workingTreeDiffers === null ? 'working tree vs committed: unknown (not a git checkout)'
    : c.workingTreeDiffers ? `working tree DIFFERS from the committed copy (${c.changedFiles.length} changed file(s))` : 'working tree matches the committed copy';
  return `${c.packagePath} (loaded as shipped) skillHash=${c.skillHash ? c.skillHash.slice(0, 12) : 'n/a'}${c.skillVersion ? ` version=${c.skillVersion}` : ''}; ${tree}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Result schema (TRD-014)
// ---------------------------------------------------------------------------------------------------------------

const SKILL_NAME = /^[A-Za-z0-9._-]+$/;
const isSkillName = (v) => typeof v === 'string' && SKILL_NAME.test(v) && v !== '.' && v !== '..';
const OUTCOMES = ['pass', 'fail', 'timed_out', 'incomplete'];
const ARM_NAMES = ['with-skill', 'baseline'];
const INVOCATION_MODES = ['plain', 'explicit'];

/** Uplift granularity per runtime (TRD design decision: Claude loads a whole package, Pi a single skill). */
const GRANULARITY = { claude: 'package', pi: 'skill' };
const UPLIFT_LABELS = { claude: 'package-level (skills share a package)', pi: 'skill-level' };
const GRANULARITY_LABELS = { package: UPLIFT_LABELS.claude, skill: UPLIFT_LABELS.pi };

class ResultError extends Error {
  constructor(message) { super(message); this.name = 'ResultError'; }
}

/** Runtime name checked against the registered runners; an unknown one is a named error. */
function assertRuntime(runtime, what = 'runtime') {
  if (typeof runtime !== 'string' || !supportedRuntimes().includes(runtime)) {
    throw new ResultError(`unknown ${what} "${String(runtime).slice(0, 60)}" (supported: ${supportedRuntimes().join(', ')})`);
  }
  return runtime;
}

/** `package` for Claude, `skill` for Pi; throws for any other runtime (never a default). */
function granularityFor(runtime) {
  assertRuntime(runtime);
  if (!GRANULARITY[runtime]) throw new ResultError(`no uplift granularity is defined for runtime "${runtime}"`);
  return GRANULARITY[runtime];
}

/**
 * Remove what must not be stored: credential values (redactDeep) and the author's machine paths (the repository
 * root becomes `<repo>`, a home directory `~`, any `/Users/<name>` or `/home/<name>` `~`).
 */
function sanitize(value, { secrets = [], repoRoot } = {}) {
  const roots = [repoRoot, os.homedir()].filter((r) => typeof r === 'string' && r.length > 1);
  const scrub = (str) => {
    let t = str;
    roots.forEach((r, i) => { t = t.split(r).join(i === 0 && repoRoot === r ? '<repo>' : '~'); });
    return t.replace(/\/(?:Users|home)\/[^/\s"'\\]+/g, '~');
  };
  const walk = (v) => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x)]));
    return v;
  };
  return walk(envlib.redactDeep(value, secrets));
}

const present = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate a stored per-run record. Throws ResultError naming `source` and the first missing or malformed field.
 * `skillVersion` and `judgeModel` may be null (no metadata.version, no judge) but the key must be present.
 */
function validateResult(r, source = 'result') {
  const bad = (field, why) => { throw new ResultError(`${source}: ${why} field "${field}"`); };
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ResultError(`${source}: a result must be a JSON object`);
  for (const k of ['evalId', 'skill', 'skillVersion', 'skillHash', 'evalVersion', 'runtime', 'model', 'arm', 'invocationMode', 'run', 'outcome', 'invoked', 'costUsd', 'durationMs', 'graders', 'replay', 'judgeModel']) {
    if (!present(r, k)) bad(k, 'missing');
  }
  if (!nonEmpty(r.evalId)) bad('evalId', 'invalid');
  if (!isSkillName(r.skill)) bad('skill', 'invalid');
  if (r.skillVersion !== null && !nonEmpty(r.skillVersion)) bad('skillVersion', 'invalid');
  if (!nonEmpty(r.skillHash)) bad('skillHash', 'invalid');
  if (!nonEmpty(r.evalVersion)) bad('evalVersion', 'invalid');
  if (!supportedRuntimes().includes(r.runtime)) bad('runtime', 'unknown value in');
  if (!nonEmpty(r.model)) bad('model', 'invalid');
  if (!ARM_NAMES.includes(r.arm)) bad('arm', 'invalid');
  if (!INVOCATION_MODES.includes(r.invocationMode)) bad('invocationMode', 'invalid');
  if (!Number.isInteger(r.run) || r.run < 1) bad('run', 'invalid');
  if (!OUTCOMES.includes(r.outcome)) bad('outcome', 'invalid');
  if (r.invoked !== null && typeof r.invoked !== 'boolean') bad('invoked', 'invalid');
  if (r.costUsd !== null && !(typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0)) bad('costUsd', 'invalid');
  if (r.durationMs !== null && !(typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0)) bad('durationMs', 'invalid');
  if (!Array.isArray(r.graders)) bad('graders', 'invalid');
  if (r.replay !== null && (typeof r.replay !== 'object' || Array.isArray(r.replay))) bad('replay', 'invalid');
  if (r.judgeModel !== null && !nonEmpty(r.judgeModel)) bad('judgeModel', 'invalid');
  return r;
}

/**
 * The stored record for one executed run. `run` is the per-run result run.js produced (evalId, arm, run, runtime, model,
 * invocationMode, outcome, invoked, costUsd, durationMs, graders, judgeModel); `ctx` = { skill, skillVersion, skillHash, evalVersion }.
 * The pipeline's `unverifiable` and `aborted` outcomes are stored as `incomplete` with `incompleteReason`: neither is a
 * pass or a fail, and neither counts toward reliability. Any other outcome value is an error.
 */
function buildResult(run, ctx) {
  const stored = { pass: 'pass', fail: 'fail', timed_out: 'timed_out', incomplete: 'incomplete', unverifiable: 'incomplete', aborted: 'incomplete' };
  const outcome = stored[run.outcome];
  if (!outcome) throw new ResultError(`run ${run.evalId || '?'}: unknown outcome "${String(run.outcome).slice(0, 40)}"`);
  const rec = {
    evalId: run.evalId,
    skill: ctx.skill,
    skillVersion: ctx.skillVersion === undefined ? null : ctx.skillVersion,
    skillHash: ctx.skillHash,
    evalVersion: ctx.evalVersion,
    runtime: run.runtime,
    model: run.model,
    arm: run.arm,
    invocationMode: run.invocationMode,
    run: run.run,
    outcome,
    ...(outcome === 'incomplete' && { incompleteReason: run.outcome === 'incomplete' ? (run.skipped || 'not run') : run.outcome }),
    invoked: typeof run.invoked === 'boolean' ? run.invoked : null,
    costUsd: typeof run.costUsd === 'number' ? run.costUsd : null,
    ...(run.costEstimated && { costEstimated: true }),
    durationMs: typeof run.durationMs === 'number' ? run.durationMs : null,
    graders: (run.graders || []).map((g) => ({ type: g.type, pass: g.pass, ...(g.judged && { judged: true }), ...(g.score !== undefined && { score: g.score }), detail: g.detail })),
    judgeModel: run.judgeModel || null,
    // The rerun command is TRD-020; until then the handle names the run, nothing more.
    replay: { evalId: run.evalId, skill: ctx.skill, runtime: run.runtime, model: run.model, arm: run.arm, run: run.run },
  };
  return validateResult(rec, `run ${run.evalId} ${run.arm} #${run.run}`);
}

/** Parse a JSON file; the error names the file. */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new ResultError(`${path.basename(file)}: cannot read (${e.code || e.message})`); }
  try { return JSON.parse(text); } catch (e) { throw new ResultError(`${path.basename(file)}: not valid JSON (${e.message})`); }
}

/** Read one stored per-run result file; rejected naming the file and the field when anything a comparison needs is missing. */
function readResult(file) {
  return validateResult(readJson(file), path.basename(file));
}

/** Read every record of a stored suite log (`records` in evals/results/*.json), validating each. */
function readRecords(file) {
  const doc = readJson(file);
  if (!doc || !Array.isArray(doc.records)) throw new ResultError(`${path.basename(file)}: no "records" array`);
  return doc.records.map((r, i) => validateResult(r, `${path.basename(file)} records[${i}]`));
}

// ---------------------------------------------------------------------------------------------------------------
// Baseline summaries (TRD-015)
// ---------------------------------------------------------------------------------------------------------------

const BASELINES_DIR = path.join(__dirname, '..', 'baselines');

class BaselineError extends Error {
  constructor(message) { super(message); this.name = 'BaselineError'; }
}

/** `<baselinesDir>/<runtime>/<skill>.json`, with the runtime and skill validated and the path kept inside `baselinesDir`. */
function baselinePath(baselinesDir, runtime, skill) {
  assertRuntime(runtime);
  if (!isSkillName(skill)) throw new BaselineError(`invalid skill name "${String(skill).slice(0, 60)}": only letters, digits, ".", "_" and "-"`);
  const root = path.resolve(baselinesDir);
  const file = path.resolve(root, runtime, `${skill}.json`);
  if (!file.startsWith(root + path.sep)) throw new BaselineError(`baseline path for "${skill}" escapes the baselines directory`);
  return file;
}

const arm = (v) => v && Number.isInteger(v.passes) && Number.isInteger(v.runs) && v.passes >= 0 && v.runs >= v.passes;

/** Validate a baseline summary object (from disk or about to be written). Throws BaselineError naming `source` and the field. */
function validateBaseline(b, source = 'baseline') {
  const bad = (field, why = 'invalid') => { throw new BaselineError(`${source}: ${why} field "${field}"`); };
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BaselineError(`${source}: a baseline summary must be a JSON object`);
  for (const k of ['skill', 'skillVersion', 'skillHash', 'evalVersion', 'model', 'runtime', 'granularity', 'repeats', 'bar', 'withSkill', 'baseline', 'reliable', 'uplift', 'recordedAt']) {
    if (!present(b, k)) bad(k, 'missing');
  }
  if (!isSkillName(b.skill)) bad('skill');
  if (b.skillVersion !== null && !nonEmpty(b.skillVersion)) bad('skillVersion');
  if (!nonEmpty(b.skillHash)) bad('skillHash');
  if (!nonEmpty(b.evalVersion)) bad('evalVersion');
  if (!nonEmpty(b.model)) bad('model');
  if (!supportedRuntimes().includes(b.runtime)) bad('runtime', 'unknown value in');
  if (b.granularity !== GRANULARITY[b.runtime]) bad('granularity', `granularity "${String(b.granularity)}" does not match runtime ${b.runtime} (expected ${GRANULARITY[b.runtime]}) in`);
  if (!Number.isInteger(b.repeats) || b.repeats < 1) bad('repeats');
  if (!Number.isInteger(b.bar) || b.bar < 1 || b.bar > b.repeats) bad('bar');
  if (!arm(b.withSkill)) bad('withSkill');
  if (!arm(b.baseline)) bad('baseline');
  if (typeof b.reliable !== 'boolean') bad('reliable');
  if (!(typeof b.uplift === 'number' && Number.isFinite(b.uplift))) bad('uplift');
  if (!nonEmpty(b.recordedAt) || Number.isNaN(Date.parse(b.recordedAt))) bad('recordedAt');
  return b;
}

/**
 * The baseline summary for a finished eval (`evalResult` from arms.summarizeEval), or a BaselineError saying why there
 * is nothing to commit: an incomplete, aborted or partly unverifiable eval is never stored as a baseline (it would
 * overwrite a committed one with a number it cannot stand behind).
 * ctx: { skillHash, skillVersion, evalVersion, model, recordedAt? }.
 */
function toBaselineSummary(evalResult, ctx) {
  const e = evalResult;
  const why = (m) => { throw new BaselineError(`eval "${e.id}": no baseline summary: ${m}`); };
  if (e.abort) why('its baseline arm aborted');
  if (!e.withSkill || !e.baseline) why('an arm has no result');
  if (e.outcome === 'incomplete' || e.reliable === null) why('the eval is incomplete');
  if (e.withSkill.notRun > 0 || e.baseline.notRun > 0) why('not every planned run executed');
  if (e.baseline.unverifiable > 0 || e.withSkill.unverifiable > 0) why('a run was unverifiable and is not counted');
  if (typeof e.uplift !== 'number') why('uplift could not be computed');
  const pick = (a) => ({ passes: a.passes, runs: a.runs });
  return validateBaseline({
    skill: e.skill,
    skillVersion: ctx.skillVersion === undefined ? null : ctx.skillVersion,
    skillHash: ctx.skillHash,
    evalVersion: ctx.evalVersion,
    model: ctx.model,
    runtime: e.runtime,
    granularity: granularityFor(e.runtime),
    repeats: e.repeats,
    bar: e.bar,
    withSkill: pick(e.withSkill),
    baseline: pick(e.baseline),
    reliable: e.reliable,
    uplift: e.uplift,
    recordedAt: ctx.recordedAt || new Date().toISOString(),
  }, `eval "${e.id}" baseline`);
}

/** Write the summary to `<baselinesDir>/<runtime>/<skill>.json` (sanitized first); returns the file path. */
function writeBaseline(baselinesDir, summary, { secrets = [], repoRoot } = {}) {
  validateBaseline(summary, `baseline for ${summary && summary.skill}`);
  const file = baselinePath(baselinesDir, summary.runtime, summary.skill);
  const clean = sanitize(summary, { secrets, repoRoot });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(validateBaseline(clean, 'sanitized baseline'), null, 2)}\n`);
  return file;
}

/** Read and validate one baseline summary file; corrupt JSON, a missing field or a mismatch with its path is an error. */
function readBaseline(file) {
  const doc = readJson(file);
  const b = validateBaseline(doc, path.basename(file));
  if (path.basename(file) !== `${b.skill}.json` || path.basename(path.dirname(file)) !== b.runtime) {
    throw new BaselineError(`${path.basename(file)}: summary is for ${b.runtime}/${b.skill} but is stored at a different path`);
  }
  return b;
}

/** The committed summary for runtime/skill, or null when no file exists; any file that exists must be valid (else it throws). */
function loadBaseline(baselinesDir, runtime, skill) {
  const file = baselinePath(baselinesDir, runtime, skill);
  if (!fs.existsSync(file)) return null;
  return readBaseline(file);
}

/** Every baseline summary under `baselinesDir` (runtime directories of valid names only); one corrupt file throws. */
function loadAllBaselines(baselinesDir) {
  if (!fs.existsSync(baselinesDir)) return [];
  const out = [];
  for (const rt of fs.readdirSync(baselinesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    assertRuntime(rt, 'runtime directory');
    for (const f of fs.readdirSync(path.join(baselinesDir, rt)).filter((n) => n.endsWith('.json')).sort()) {
      out.push(readBaseline(path.join(baselinesDir, rt, f)));
    }
  }
  return out;
}

/**
 * Compare a fresh summary with the committed one. status: `not-comparable` (model, runtime, eval version or repeats differ:
 * said, never passed), `regression` (the committed summary was reliable and the new one is not), else `ok`.
 */
function compareSummaries(committed, current) {
  const reasons = [];
  for (const k of ['runtime', 'model', 'evalVersion', 'repeats']) {
    if (committed[k] !== current[k]) reasons.push(`${k} differs (committed ${committed[k]}, now ${current[k]})`);
  }
  if (reasons.length) return { status: 'not-comparable', reasons };
  if (committed.reliable && !current.reliable) {
    return { status: 'regression', reasons: [`was reliable (${committed.withSkill.passes}/${committed.withSkill.runs}, bar ${committed.bar}), now ${current.withSkill.passes}/${current.withSkill.runs}`] };
  }
  return { status: 'ok', reasons: [] };
}

/**
 * Regression check of a finished eval against the committed file under `baselinesDir`. status: `no-baseline`, `incomplete`
 * (the new result cannot be summarized: never a pass), or the compareSummaries verdict. A corrupt committed file throws.
 */
function checkAgainstBaseline(baselinesDir, evalResult, ctx) {
  const committed = loadBaseline(baselinesDir, evalResult.runtime, evalResult.skill);
  if (!committed) return { status: 'no-baseline', reasons: ['no committed summary'] };
  let current;
  try { current = toBaselineSummary(evalResult, ctx); } catch (e) {
    if (!(e instanceof BaselineError)) throw e;
    return { status: 'incomplete', reasons: [e.message] };
  }
  return { ...compareSummaries(committed, current), committed };
}

module.exports = {
  summarizeRun, evaluatedCopy, describeCopy,
  hashDir: hash.hashTree, skillVersion: hash.skillVersion,
  GRANULARITY, UPLIFT_LABELS, GRANULARITY_LABELS, OUTCOMES, ARM_NAMES, BASELINES_DIR, SKILL_NAME, isSkillName,
  ResultError, BaselineError, assertRuntime, granularityFor, sanitize,
  validateResult, buildResult, readResult, readRecords,
  baselinePath, validateBaseline, toBaselineSummary, writeBaseline, readBaseline, loadBaseline, loadAllBaselines, compareSummaries, checkAgainstBaseline,
};

