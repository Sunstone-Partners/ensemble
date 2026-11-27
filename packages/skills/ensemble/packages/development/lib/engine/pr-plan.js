'use strict';

/**
 * TRD-013 (TRD-2026-d571763f): the saved branch choices and the PR plan, read once.
 *
 * `implement branch` has always read these four things; the quality gate needs the same answers
 * to know whether this run is stacked (the phase story stays open and a PR follows) or single-PR
 * (the phase story closes here). They moved out of `verbs/implement-branch.js` unchanged rather
 * than being re-implemented, because two readers of `trd-cli pr-plan` could disagree about the
 * branch a phase belongs to -- and the one thing the plan exists to settle is exactly that.
 *
 * Nothing here decides anything: `trd-cli pr-plan` owns the plan (`skills/
 * implement-trd-tasks-reference/SKILL.md:24` names it as the only source for branch names), and
 * these functions report what it said.
 */

const path = require('path');
const { refused, unavailable } = require('./result');
const { runTrd } = require('./cli-json');

/**
 * The choices a previous run saved in the TRD's frontmatter (SKILL.md:23).
 * @param {object} call the dispatcher's call object
 * @param {string} trdPath project-relative
 * @returns {{branchName: string, stackedPrs: boolean|null, useProposed: boolean}|object}
 */
function readSavedChoices(call, trdPath) {
  const result = runTrd(call, ['choices-read', trdPath]);
  if (!result.json) {
    return unavailable(
      'CHOICES_UNREADABLE',
      `trd-cli choices-read produced no JSON result (exit ${result.exitCode})${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`
    );
  }
  if (typeof result.json.error === 'string') {
    return refused('CHOICES_UNREADABLE', result.json.error);
  }
  const choices = result.json.choices || {};
  return {
    branchName: typeof choices.branch_name === 'string' ? choices.branch_name : '',
    stackedPrs: typeof choices.stacked_prs === 'boolean' ? choices.stacked_prs : null,
    useProposed: choices.use_proposed === true,
  };
}

/**
 * Whether this run plans stacked PRs (SKILL.md:24): the environment toggle wins, then the saved
 * choice, then `false`.
 * @param {object} env
 * @param {boolean|null} saved
 * @returns {boolean}
 */
function effectiveStacked(env, saved) {
  const raw = env && env.ENSEMBLE_USE_STACKED_PRS;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return saved === true;
}

/**
 * The PR plan, from the one CLI that owns it.
 * @param {object} call the dispatcher's call object
 * @param {string} trdPath project-relative
 * @param {boolean} stacked
 * @returns {{actions: object[], branchFirst: string, slug: string, stacked: boolean}|object}
 */
function readPrPlan(call, trdPath, stacked) {
  const result = runTrd(call, ['pr-plan', trdPath, ...(stacked ? ['--stacked'] : [])]);
  if (!result.json) {
    return unavailable(
      'PR_PLAN_UNREADABLE',
      `trd-cli pr-plan produced no JSON result (exit ${result.exitCode})${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`
    );
  }
  if (typeof result.json.error === 'string') {
    return refused('PR_PLAN_FAILED', result.json.error);
  }
  if (result.json.ok !== true) {
    return refused('PR_PLAN_FAILED', `trd-cli pr-plan refused '${trdPath}'`);
  }
  return {
    actions: Array.isArray(result.json.actions) ? result.json.actions : [],
    branchFirst: String(result.json.branchFirst || ''),
    slug: String(result.json.slug || ''),
    stacked: result.json.stacked === true,
  };
}

/**
 * Reuse mode: the whole build runs on one existing branch, so every per-phase branch and parent
 * link in the plan is replaced and only the completion entry opens a PR (SKILL.md:28).
 * @param {{actions: object[], branch: string, slug: string, trdPath: string}} input
 * @returns {object[]} the rewritten actions
 */
function rewriteForReuse({ actions, branch, slug, trdPath }) {
  const rewritten = [];
  for (const action of actions) {
    if (action.kind === 'completion') continue;
    rewritten.push({
      ...action,
      appendNextBranch: '',
      branch,
      createPr: false,
      parentBranch: '',
    });
  }
  rewritten.push({
    appendNextBranch: '',
    branch,
    createPr: true,
    kind: 'completion',
    parentBranch: '',
    proposeTitle: `Implement ${slug} (${path.basename(trdPath)})`,
    summaryKind: 'single',
  });
  return rewritten;
}

/**
 * The saved choices and the plan they imply, in one read -- the pair every verb downstream of
 * `implement branch` needs before it can say what a passing phase means.
 *
 * @param {object} call the dispatcher's call object
 * @param {string} trdPath project-relative
 * @returns {{actions: object[], branchFirst: string, saved: object, slug: string,
 *   stacked: boolean}|object} the plan, or a tagged engine result
 */
function savedPlan(call, trdPath) {
  const saved = readSavedChoices(call, trdPath);
  if (saved && saved.status) return saved;
  const stacked = effectiveStacked(call.env, saved.stackedPrs);
  const plan = readPrPlan(call, trdPath, stacked);
  if (plan && plan.status) return plan;
  return { ...plan, saved };
}

/**
 * The plan entry for one phase's gate, or null when the plan has none.
 *
 * `createPr` is the whole question a gate asks of the plan: `false` means this phase's work
 * lands on a shared branch and the story closes here; `true` means a PR follows, so the story
 * stays open until that PR exists.
 *
 * @param {{actions: object[]}} plan
 * @param {number} phaseN
 * @returns {object|null}
 */
function gateAction(plan, phaseN) {
  const actions = (plan && plan.actions) || [];
  return actions.find(a => a && a.kind === 'phase-gate' && Number(a.phaseN) === phaseN) || null;
}

/**
 * The plan's completion entry -- the one action that is about the TRD as a whole rather than a
 * phase -- or null.
 *
 * @param {{actions: object[]}} plan
 * @returns {object|null}
 */
function completionAction(plan) {
  const actions = (plan && plan.actions) || [];
  return actions.find(a => a && a.kind === 'completion') || null;
}

module.exports = {
  completionAction,
  effectiveStacked,
  gateAction,
  readPrPlan,
  readSavedChoices,
  rewriteForReuse,
  savedPlan,
};
