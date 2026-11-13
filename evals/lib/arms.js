'use strict';

/**
 * With-skill and baseline arms. One eval definition yields two jobs that differ only in what is loaded:
 *   with-skill: the package that ships the skill, as shipped (`pluginDirs`, never a copy)
 *   baseline:   nothing for the skill under test
 * Same prompt text, workspace content, tools and settings in both arms; `invocation: explicit` prefixes the
 * command on the with-skill arm only. A baseline that has the skill loaded or invoked is a leak: the eval aborts.
 */

const path = require('path');
const exec = require('./exec');
const results = require('./results');
const claude = require('./runners/claude');

const ARMS = ['with-skill', 'baseline'];

/** How each runtime's uplift is to be read (TRD design decision: the Claude arm loads a whole package). */
const UPLIFT_LABELS = { claude: 'package-level (skills share a package)', pi: 'skill-level' };
const upliftLabel = (runtime) => UPLIFT_LABELS[runtime] || 'unknown granularity';

const expandRepo = (text, repoRoot) => String(text).split('{{repo}}').join(repoRoot);

/** Job for a legacy single-arm scenario: its `plugins` become package directories, as before. */
function scenarioJob(scenario, { repoRoot, model, maxUsd, workspace, env, timeoutMs }) {
  return {
    evalId: scenario.id, skill: scenario.skill || null, arm: 'with-skill', runtime: 'claude', model, workspace, env, timeoutMs, maxUsd,
    prompt: expandRepo(scenario.prompt, repoRoot),
    pluginDirs: (scenario.plugins || []).map((pkg) => path.join(repoRoot, 'packages', pkg)),
    maxTurns: scenario.maxTurns, allowedTools: scenario.allowedTools, permissionMode: scenario.permissionMode,
  };
}

/**
 * Job for one arm of a skill eval `ev` (as loaded by eval-def). ctx: { repoRoot, runtime, model, workspace, env,
 * timeoutMs, maxUsd }. The with-skill job carries the shipped package directory in `pluginDirs` and the skill
 * directory in `skillPaths`; the baseline carries neither.
 */
function buildJob(ev, arm, ctx) {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm "${arm}"`);
  const { repoRoot, runtime = 'claude', model, workspace, env, timeoutMs, maxUsd } = ctx;
  const withSkill = arm === 'with-skill';
  const task = expandRepo(ev.prompt, repoRoot);
  return {
    evalId: ev.id, skill: ev.skill, arm, runtime, model, workspace, env, timeoutMs, maxUsd,
    prompt: withSkill && ev.invocation === 'explicit' ? `${ev.command} ${task}` : task,
    pluginDirs: withSkill ? [path.join(repoRoot, 'packages', ev.package)] : [],
    skillPaths: withSkill ? [path.join(repoRoot, 'packages', ev.package, 'skills', ev.skill)] : [],
    maxTurns: ev.maxTurns, allowedTools: ev.allowedTools, permissionMode: undefined,
    invocationMode: ev.invocation,
  };
}

/** `plugin:skill` and bare `skill` both name `skill`. */
const skillMatches = (entry, skill) => typeof entry === 'string' && (entry === skill || entry.endsWith(`:${skill}`));

/** Whether the skill under test was invoked, from the runner's invocation events (falls back to a transcript scan). */
function wasInvoked(skill, result) {
  const invoked = Array.isArray(result.invokedSkills) ? result.invokedSkills : claude.analyzeTranscript(result.transcript || '').invokedSkills;
  return invoked.some((s) => skillMatches(s, skill));
}

/**
 * Leak check for a baseline run: null when clean, else a message naming the leak. A leak is the skill under test
 * reported loaded (startup event) or invoked (transcript) by the runtime, or its package loaded as a plugin.
 */
function detectLeak(ev, result, { repoRoot }) {
  const how = [];
  const loaded = (result.loadedSkills || []).filter((s) => skillMatches(s, ev.skill));
  const invoked = (Array.isArray(result.invokedSkills) ? result.invokedSkills : []).filter((s) => skillMatches(s, ev.skill));
  if (invoked.length) how.push(`invoked in the transcript (${invoked.join(', ')})`);
  else if (loaded.length) how.push(`reported loaded by the runtime (${loaded.join(', ')})`);
  const pkgDir = path.resolve(repoRoot, 'packages', ev.package);
  const plugin = (result.loadedPlugins || []).find((p) => path.resolve(p.path) === pkgDir);
  if (plugin) how.push(`its package ${ev.package} was loaded as plugin ${plugin.name}`);
  if (!how.length) return null;
  return `eval "${ev.id}": baseline arm leaked the skill under test "${ev.skill}": ${how.join('; ')}; eval aborted, baseline not scored`;
}

/** Uplift as a fraction: with-skill pass rate minus baseline pass rate; null when either arm has no executed run. */
function uplift(withStats, baseStats) {
  if (!withStats.runs || !baseStats.runs) return null;
  return withStats.passes / withStats.runs - baseStats.passes / baseStats.runs;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Eval-level result from its per-run results. runs: { 'with-skill': [...], baseline: [...] } (executed runs only;
 * a run that never started is simply absent). plan: { repeats, bar, repeatsSource, barSource }.
 * `abort` (string) marks a leaked baseline: the baseline is not scored and the eval fails.
 */
function summarizeEval(ev, plan, runs, { runtime = 'claude', abort = null, copy = null } = {}) {
  const withRuns = runs['with-skill'] || [];
  const baseRuns = runs.baseline || [];
  const withStats = exec.armStats(withRuns, plan.repeats);
  const baseStats = abort ? null : exec.armStats(baseRuns, plan.repeats);
  const reliable = abort ? false : exec.reliability(withStats, plan.bar, plan.repeats);
  const all = [...withRuns, ...baseRuns];
  const cost = all.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const invokedRuns = withRuns.filter((r) => r.invoked).length;
  const judged = withRuns.map((r) => r.judgedScore).filter((x) => typeof x === 'number');
  const outcome = reliable === true ? 'pass' : reliable === false ? 'fail' : 'incomplete';
  return {
    id: ev.id, type: 'agent', skill: ev.skill, runtime, arms: true,
    outcome, pass: reliable === null ? null : reliable, verdict: reliable === true ? 'pass' : reliable === false ? 'fail' : null,
    repeats: plan.repeats, repeatsSource: plan.repeatsSource, bar: plan.bar, barSource: plan.barSource,
    reliable, invocationMode: ev.invocation,
    withSkill: withStats, baseline: baseStats,
    uplift: abort ? null : uplift(withStats, baseStats),
    upliftLabel: upliftLabel(runtime),
    expectInvoked: ev.expectInvoked === undefined ? null : ev.expectInvoked,
    invokedRuns,
    invokedAsExpected: ev.expectInvoked === undefined || !withRuns.length ? null : (ev.expectInvoked ? invokedRuns === withRuns.length : invokedRuns === 0),
    ...(abort && { abort }),
    evaluatedCopy: copy,
    judgedScore: mean(judged),
    judgeModel: (withRuns.find((r) => r.judgeModel) || {}).judgeModel || null,
    costUsd: cost,
    ...(all.some((r) => r.costEstimated) && { costEstimated: true }),
    graders: [],
    runs: all,
  };
}

module.exports = {
  ARMS, UPLIFT_LABELS, upliftLabel, scenarioJob, buildJob, skillMatches, wasInvoked, detectLeak, uplift, summarizeEval,
  evaluatedCopy: results.evaluatedCopy,
};
